// src/index.mjs
// Public API for @palveron/agent-shield.
// This package is a thin OpenClaw client over @palveron/sdk — NO proprietary
// logic, NO duplicated verify contract.

export { ShieldClient, normalizeDecision } from './client.mjs';
export { classifyRisk, shouldVerify, isDestructive } from './risk-classifier.mjs';
export { startMcpServer } from './mcp-server.mjs';
export {
  transportFallback,
  isFailLoud,
  failClosedOverride,
  FAIL_CLOSED_REASON,
  FAIL_OPEN_REASON,
} from './fail-policy.mjs';
