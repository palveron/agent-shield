// src/risk-classifier.mjs
// Local tool-risk classification for OpenClaw tool calls.
// This is intentionally simple — the real intelligence lives server-side.
// Only HIGH-RISK tools trigger a governance check (verify call).
// LOW-RISK tools are logged as traces but not blocked.

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
 * Classify a tool call's risk level.
 *
 * @param {string} toolName - The tool being called
 * @returns {'HIGH' | 'MEDIUM' | 'LOW'}
 */
export function classifyRisk(toolName) {
  const normalized = toolName.toLowerCase().replace(/[-\s]/g, '_');

  if (HIGH_RISK_TOOLS.has(normalized)) return 'HIGH';
  if (MEDIUM_RISK_TOOLS.has(normalized)) return 'MEDIUM';

  // Unknown tools default to MEDIUM — better safe than sorry
  // but not aggressive enough to block everything
  return 'MEDIUM';
}

/**
 * Should this tool call be sent to the governance API?
 * HIGH → always verify
 * MEDIUM → verify (but don't block workflow if API is down)
 * LOW → skip (only log as trace)
 *
 * @param {string} toolName
 * @returns {boolean}
 */
export function shouldVerify(toolName) {
  const risk = classifyRisk(toolName);
  return risk === 'HIGH' || risk === 'MEDIUM';
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
