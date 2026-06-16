// src/risk-classifier.mjs
// Local tool-risk classification for OpenClaw tool calls.
// This is intentionally simple — the real intelligence lives server-side.
// There is no LOW skip tier: every governance_check is verified AND traced.
// The classifier only decides the FAIL POLICY on a gateway outage:
//   HIGH   → fail-closed (BLOCK)
//   MEDIUM → fail-open  (ALLOW)
// Unknown tools default to MEDIUM (never skipped).

const HIGH_RISK_TOOLS = new Set([
  // Shell/System
  'exec', 'shell', 'bash', 'run_command', 'execute_command',
  'terminal', 'subprocess',
  // File Destructive
  'delete_file', 'remove_file', 'write_file', 'move_file',
  'rename_file', 'overwrite',
  // Git
  'git_push', 'git_push_force', 'git_reset_hard',
  // Network
  'http_request', 'fetch_url', 'curl', 'download',
  'send_email', 'send_message',
  // Package Management
  'install_package', 'npm_install', 'pip_install',
  'apt_install', 'brew_install',
  // Browser
  'navigate', 'browser_navigate', 'fill_form', 'click',
  // Social Media
  'post_tweet', 'send_slack', 'send_teams', 'publish',
  // Database
  'sql_query', 'db_execute', 'drop_table',
  // Financial
  'transfer', 'payment', 'purchase', 'buy', 'sell',
]);

const MEDIUM_RISK_TOOLS = new Set([
  // File Read
  'read_file', 'list_directory', 'search_files',
  'glob', 'find_files',
  // Git Read
  'git_status', 'git_log', 'git_diff',
  // Memory
  'memory_write', 'memory_update', 'save_context',
]);

/**
 * Classify a tool call's risk level. Drives only the outage fail policy
 * (HIGH → fail-closed, MEDIUM → fail-open). There is no LOW tier.
 *
 * @param {string} toolName - The tool being called
 * @returns {'HIGH' | 'MEDIUM'}
 */
export function classifyRisk(toolName) {
  const normalized = toolName.toLowerCase().replace(/[-\s]/g, '_');

  if (HIGH_RISK_TOOLS.has(normalized)) return 'HIGH';
  if (MEDIUM_RISK_TOOLS.has(normalized)) return 'MEDIUM';

  // Unknown tools default to MEDIUM — verified like everything else, and
  // fail-open on a gateway outage (only known-dangerous tools fail closed).
  return 'MEDIUM';
}

/**
 * Is this a tool call that could be destructive?
 * Used for CLI status output.
 *
 * @param {string} toolName
 * @returns {boolean}
 */
export function isDestructive(toolName) {
  return classifyRisk(toolName) === 'HIGH';
}
