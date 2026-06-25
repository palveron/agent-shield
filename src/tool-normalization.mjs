// src/tool-normalization.mjs
// Übersetzt native OpenClaw-Tool-Namen in die Capability-Taxonomie des Gateways
// (prefix:action). NUR für den an den Gateway gesendeten context.tool_name —
// classifyRisk + Logs bleiben nativ (siehe client.mjs). Der Gateway bleibt
// framework-agnostisch; diese OpenClaw-Übersetzung gehört in den Adapter.
//
// Map = BEFUND_AGENT_ID_ACTIVATION.md Strang B (verbatim). Unter dem Goal-1-
// Preset landen die Ziel-Keys auf: ai/communication/data → ALLOW,
// external → REQUIRE_APPROVAL (mit api:get-Override → ALLOW), infrastructure →
// DENY. Dadurch: web_search/send_email → ALLOW (unbeaufsichtigter Lauf
// überlebt), exec/install_package → DENY (Code-Exec hart blocken).
const TOOL_MAP = Object.freeze({
  exec: 'infra:code_exec', shell: 'infra:code_exec', bash: 'infra:code_exec',
  run_command: 'infra:code_exec', terminal: 'infra:code_exec', subprocess: 'infra:code_exec',
  install_package: 'infra:code_exec', npm_install: 'infra:code_exec', pip_install: 'infra:code_exec',
  apt_install: 'infra:code_exec', brew_install: 'infra:code_exec',
  read_file: 'files:read', list_directory: 'files:read', search_files: 'files:read',
  glob: 'files:read', find_files: 'files:read',
  write_file: 'files:write', move_file: 'files:write', rename_file: 'files:write',
  delete_file: 'files:delete', remove_file: 'files:delete',
  sql_query: 'db:query', db_execute: 'db:mutate', drop_table: 'db:mutate',
  send_email: 'email:send', send_message: 'slack:send', send_slack: 'slack:send',
  web_search: 'api:get', fetch_url: 'api:get', download: 'api:get',
  git_status: 'api:get', git_log: 'api:get', git_diff: 'api:get',
  navigate: 'api:get', browser_navigate: 'api:get',
  http_request: 'api:post', curl: 'api:post',
  git_push: 'api:post', git_push_force: 'api:post', git_reset_hard: 'api:post',
  fill_form: 'api:post', click: 'api:post', post_tweet: 'api:post', publish: 'api:post',
  transfer: 'payment:execute', payment: 'payment:execute', purchase: 'payment:execute',
  buy: 'payment:execute', sell: 'payment:execute',
});

/**
 * Translate a native OpenClaw tool name to the gateway capability key
 * (`prefix:action`). For the gateway `context.tool_name` ONLY — never for
 * `classifyRisk`/logs, which must stay native (the outage fail-policy keys off
 * the native name).
 *
 * @param {string} native - The native tool name (e.g. "send_email", "exec").
 * @returns {string} The mapped `prefix:action` key, or — for an unknown tool —
 *   the normalized native key WITHOUT a ':', which the gateway's
 *   `resolve_category` `_`-arm routes to `external` → REQUIRE_APPROVAL (the safe
 *   default catch, BEFUND Strang B).
 */
export function normalizeToolName(native) {
  if (!native) return native;
  // Same normalization as classifyRisk (risk-classifier.mjs:53): lower + [-\s]→_,
  // so "send-email" / "Send Email" / "send_email" all collapse to one key.
  const key = String(native).toLowerCase().replace(/[-\s]/g, '_');
  return TOOL_MAP[key] ?? key;
}
