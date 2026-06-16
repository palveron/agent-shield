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
import { classifyRisk } from './risk-classifier.mjs';

const PROTOCOL_VERSION = '2024-11-05';

/**
 * Start the MCP server on stdin/stdout.
 * Called by bin/agent-shield-mcp.
 */
export async function startMcpServer() {
  const apiUrl = process.env.PALVERON_API_URL || process.env.AGENT_SHIELD_API_URL;
  const apiKey = process.env.PALVERON_API_KEY || process.env.AGENT_SHIELD_API_KEY;

  if (!apiUrl || !apiKey) {
    writeError(
      'Missing required environment variables: PALVERON_API_URL and PALVERON_API_KEY (or AGENT_SHIELD_API_URL and AGENT_SHIELD_API_KEY)'
    );
    process.exit(1);
  }

  // BYOM note: the gateway uses the project's server-side LLM key
  // (dashboard → Settings → Neural Gateway). No LLM key is read or forwarded here.
  const client = new ShieldClient({
    apiUrl,
    apiKey,
    timeout: 3000, // MCP needs to be fast
    maxRetries: 1, // fail fast on the hot path; the fail policy tiers the outcome
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
          name: 'palveron-governance',
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
              'Check if a tool call is allowed by Palveron governance policies. ' +
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

  // F1: a malformed call (missing tool_name or input) must NEVER be a silent
  // ALLOW — that is the one path that lets a broken/tampered governance_check
  // bypass the gateway, and without tool_name the risk level isn't even
  // knowable. Surface ERROR (SKILL.md handles it without proceeding on HIGH-RISK).
  if (!toolName || !input) {
    sendResponse(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            decision: 'ERROR',
            reason: 'missing_required_field',
            error: 'governance_check requires tool_name and input',
          }),
        },
      ],
    });
    return;
  }

  // F4: there is no LOW skip tier. Every governance_check goes through
  // client.verify so it is both evaluated AND recorded as a trace — a local
  // skip would return ALLOW without a gateway call, making the action invisible
  // in the dashboard (breaking the "see everything" promise).
  try {
    // client.verify applies the tiered fail policy (B3): a real verdict, or a
    // risk-tiered fallback on transport failure (HIGH → BLOCK, MEDIUM/LOW →
    // ALLOW). It only THROWS for fail-loud contract/auth failures (next catch).
    const result = await client.verify({
      agentId,
      toolName,
      input,
      metadata: {
        context: args?.context || null,
      },
    });

    sendResponse(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            decision: result.decision,
            reason: result.reason || null,
            modified_input: result.modified_input || null,
            trace_id: result.trace_id || null,
            risk_level: classifyRisk(toolName),
            ...(result._fallback ? { _fallback: true } : {}),
          }),
        },
      ],
    });
  } catch (err) {
    // FAIL-LOUD: a contract (400) or auth (401) failure is our bug or a
    // misconfiguration. NEVER report ALLOW — that is exactly what hid the
    // launch-blocking governance gap. Surface an explicit ERROR so the agent
    // (per SKILL.md) treats high-risk actions with caution instead of
    // proceeding silently.
    sendResponse(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            decision: 'ERROR',
            reason: 'governance_check_failed',
            error: err?.message || String(err),
            risk_level: classifyRisk(toolName),
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
