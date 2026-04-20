#!/usr/bin/env node
// bin/agent-shield-mcp.mjs
// Entry point for OpenClaw MCP Server integration.
// This is referenced in openclaw.json: "command": "npx", "args": ["-y", "agent-shield-mcp"]

import { startMcpServer } from '../src/mcp-server.mjs';

startMcpServer().catch((err) => {
  process.stderr.write(`[agent-shield-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
