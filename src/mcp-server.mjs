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
import { createStdioTransport } from './stdio-transport.mjs';
import { dlog } from './debug-log.mjs';

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

  // JSON-RPC over stdio — NDJSON (MCP standard) with Content-Length tolerance.
  // The transport detects the input framing and mirrors it on responses.
  const transport = createStdioTransport({
    onMessage: (msg) => handleMessage(msg, client, agentId, transport),
    write: (s) => process.stdout.write(s),
    onParseError: () => writeError('Failed to parse JSON-RPC message'),
  });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => transport.push(chunk));
}

async function handleMessage(message, client, agentId, transport) {
  const { id, method, params } = message;

  // mcp_msg — proves the in-process call ORDER (probe/list before the failing
  // tools/call?) and, via pid+seq adjacency, correlates each gateway call to the
  // MCP message that triggered it. Decides H1/H5. Secret-safe: for tools/call we
  // log only the tool name + argument KEY NAMES + byte size, never the argument
  // values (PII risk).
  {
    const ev = { method, ...(id !== undefined ? { id } : {}) };
    if (method === 'tools/call') {
      const args = params?.arguments;
      ev.mcpToolName = params?.name ?? null;
      ev.toolName = typeof args?.tool_name === 'string' ? args.tool_name : null;
      ev.argKeys = args && typeof args === 'object' ? Object.keys(args) : [];
      try {
        ev.argBytes = args !== undefined ? Buffer.byteLength(JSON.stringify(args)) : 0;
      } catch {
        ev.argBytes = -1;
      }
    }
    dlog('mcp_msg', ev);
  }

  switch (method) {
    case 'initialize':
      sendResponse(transport, id, {
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
      sendResponse(transport, id, {
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
      await handleToolCall(id, params, client, agentId, transport);
      break;

    default:
      // Unknown method — respond with method not found
      if (id !== undefined) {
        sendError(transport, id, -32601, `Method not found: ${method}`);
      }
  }
}

async function handleToolCall(id, params, client, agentId, transport) {
  const { name, arguments: args } = params || {};

  if (name !== 'governance_check') {
    sendError(transport, id, -32602, `Unknown tool: ${name}`);
    return;
  }

  const toolName = args?.tool_name;
  const input = args?.input;

  // F1: a malformed call (missing tool_name or input) must NEVER be a silent
  // ALLOW — that is the one path that lets a broken/tampered governance_check
  // bypass the gateway, and without tool_name the risk level isn't even
  // knowable. Surface ERROR (SKILL.md handles it without proceeding on HIGH-RISK).
  if (!toolName || !input) {
    sendResponse(transport, id, {
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

    sendResponse(transport, id, {
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
    sendResponse(transport, id, {
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

function sendResponse(transport, id, result) {
  transport.send({ jsonrpc: '2.0', id, result });
}

function sendError(transport, id, code, message) {
  transport.send({ jsonrpc: '2.0', id, error: { code, message } });
}

function writeError(msg) {
  process.stderr.write(`[agent-shield] ERROR: ${msg}\n`);
}
