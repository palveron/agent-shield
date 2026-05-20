// src/index.mjs
// Public API for @palveron/agent-shield
// This package is a thin client — NO proprietary logic.

export { ShieldClient, ShieldApiError } from './client.mjs';
export { classifyRisk, shouldVerify, isDestructive } from './risk-classifier.mjs';
export { startMcpServer } from './mcp-server.mjs';
