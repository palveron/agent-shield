#!/usr/bin/env node
// bin/agent-shield-mcp.mjs
// Entry point for OpenClaw MCP Server integration.
// This is referenced in openclaw.json: "command": "npx", "args": ["-y", "agent-shield-mcp"]

import { startMcpServer } from '../src/mcp-server.mjs';
import { dlog, keyMeta, collectProxyEnv } from '../src/debug-log.mjs';

// proc_start — emitted as early as possible so the log captures exactly what the
// SPAWNED process sees (vs. what `openclaw mcp show` claims). Decides H2 (inherited
// proxy/NODE_OPTIONS), H3 (env divergence), H4 (cwd). Reads the same env aliases
// the client reads (mcp-server.mjs: PALVERON_* preferred, AGENT_SHIELD_* fallback).
// Secret-safe: the key appears only as presence + length.
{
  const apiUrl = process.env.PALVERON_API_URL || process.env.AGENT_SHIELD_API_URL || null;
  const apiKey = process.env.PALVERON_API_KEY || process.env.AGENT_SHIELD_API_KEY || '';
  const km = keyMeta(apiKey);
  dlog('proc_start', {
    cwd: process.cwd(),
    argv: process.argv,
    nodeVersion: process.version,
    apiUrl,
    apiUrlEnvSeen: {
      PALVERON_API_URL: process.env.PALVERON_API_URL ?? null,
      AGENT_SHIELD_API_URL: process.env.AGENT_SHIELD_API_URL ?? null,
    },
    apiKeyPresent: km.present,
    apiKeyLen: km.len,
    agentId: process.env.AGENT_SHIELD_AGENT_ID ?? null, // not a secret
    proxyEnv: collectProxyEnv(),
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    failClosedOverride: process.env.AGENT_SHIELD_FAIL_CLOSED ?? null,
  });
}

startMcpServer().catch((err) => {
  dlog('proc_fatal', { errName: err?.name, errMessage: String(err?.message ?? err).slice(0, 300) });
  process.stderr.write(`[agent-shield-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
