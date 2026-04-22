// src/mcp-server.mjs
// MCP Server for agent-shield.
// OpenClaw connects to this via stdio transport (openclaw.json config).
// Exposes one tool: "governance_check" — the agent calls it before HIGH-RISK operations.
//
// IMPORTANT: This is a thin wrapper. All intelligence lives server-side.
// This file only:
// 1. Receives tool calls from OpenClaw
// 2. Forwards them to the governance API via ShieldClient
// 3. Returns ALLOW/BLOCK/MODIFY decisions

import { ShieldClient } from './client.mjs';
import { classifyRisk, shouldVerify } from './risk-classifier.mjs';

const PROTOCOL_VERSION = '2024-11-05';

/**
 * Start the MCP server on stdin/stdout.
 * Called by bin/agent-shield-mcp.
 */
export async function startMcpServer() {
  const apiUrl = process.env.PALVERON_API_URL || process.env.AGENT_SHIELD_API_URL;
  const apiKey = process.env.PALVERON_API_KEY || process.env.AGENT_SHIELD_API_KEY;
  const llmApiKey =
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.LLM_API_KEY;

  if (!apiUrl || !apiKey) {
    writeError(
      'Missing required environment variables: PALVERON_API_URL and PALVERON_API_KEY (or AGENT_SHIELD_API_URL and AGENT_SHIELD_API_KEY)'
    );
    process.exit(1);
  }

  const client = new ShieldClient({
    apiUrl,
    apiKey,
    llmApiKey,
    timeout: 3000, // MCP needs to be fast
  });

  const agentId = process.env.AGENT_SHIELD_AGENT_ID || 'default';

  // JSON-RPC over stdio
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    processBuffer();
  });

  function processBuffer() {
    // MCP uses Content-Length framing
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) break;

      const body = buffer.slice(bodyStart, bodyStart + contentLength);
      buffer = buffer.slice(bodyStart + contentLength);

      try {
        const message = JSON.parse(body);
        handleMessage(message, client, agentId);
      } catch {
        writeError('Failed to parse JSON-RPC message');
      }
    }
  }
}

async function handleMessage(message, client, agentId) {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: 'agent-shield',
          version: '0.1.0',
        },
      });
      break;

    case 'notifications/initialized':
      // No response needed for notifications
      break;

    case 'tools/list':
      sendResponse(id, {
        tools: [
          {
            name: 'governance_check',
            description:
              'Check if a tool call is allowed by governance policies. ' +
              'Call this BEFORE executing any HIGH-RISK action (exec, shell, ' +
              'delete_file, git_push, http_request, install_package). ' +
              'Returns ALLOW, BLOCK (with reason), or MODIFY (with sanitized version).',
            inputSchema: {
              type: 'object',
              properties: {
                tool_name: {
                  type: 'string',
                  description:
                    'The tool being called (e.g. "exec", "delete_file")',
                },
                input: {
                  type: 'string',
                  description:
                    'The input/command being passed to the tool',
                },
                context: {
                  type: 'string',
                  description:
                    'Optional: why this action is needed (helps with approval workflow)',
                },
              },
              required: ['tool_name', 'input'],
            },
          },
        ],
      });
      break;

    case 'tools/call':
      await handleToolCall(id, params, client, agentId);
      break;

    default:
      // Unknown method — respond with method not found
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

async function handleToolCall(id, params, client, agentId) {
  const { name, arguments: args } = params || {};

  if (name !== 'governance_check') {
    sendError(id, -32602, `Unknown tool: ${name}`);
    return;
  }

  const toolName = args?.tool_name;
  const input = args?.input;

  if (!toolName || !input) {
    sendResponse(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            decision: 'ALLOW',
            reason: 'Missing tool_name or input — allowing by default',
          }),
        },
      ],
    });
    return;
  }

  // Quick risk check — skip API call for truly LOW-RISK operations
  if (!shouldVerify(toolName)) {
    sendResponse(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            decision: 'ALLOW',
            reason: 'low_risk_tool',
            risk_level: classifyRisk(toolName),
          }),
        },
      ],
    });
    return;
  }

  try {
    const result = await client.verify({
      agentId,
      toolName,
      input,
      metadata: {
        risk_level: classifyRisk(toolName),
        context: args?.context || null,
      },
    });

    sendResponse(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            decision: result.decision || 'ALLOW',
            reason: result.reason || null,
            modified_input: result.modified_input || null,
            trace_id: result.trace_id || null,
            risk_level: classifyRisk(toolName),
          }),
        },
      ],
    });
  } catch (err) {
    // On error, ALLOW — never block the user's workflow due to our failure
    sendResponse(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            decision: 'ALLOW',
            reason: 'governance_api_error',
            error: err.message,
          }),
        },
      ],
    });
  }
}

function sendResponse(id, result) {
  const response = JSON.stringify({
    jsonrpc: '2.0',
    id,
    result,
  });
  const header = `Content-Length: ${Buffer.byteLength(response)}\r\n\r\n`;
  process.stdout.write(header + response);
}

function sendError(id, code, message) {
  const response = JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
  const header = `Content-Length: ${Buffer.byteLength(response)}\r\n\r\n`;
  process.stdout.write(header + response);
}

function writeError(msg) {
  process.stderr.write(`[agent-shield] ERROR: ${msg}\n`);
}
