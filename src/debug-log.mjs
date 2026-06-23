// src/debug-log.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Env-gated, zero-dependency, secret-safe JSONL spawn diagnostics.
//
// WHY THIS EXISTS
//   OpenClaw (and other agent hosts) spawn the MCP server as a subprocess and
//   swallow its stderr — a `console.error` is invisible AND throwaway. This is a
//   permanent, reusable facility: when a spawned governance process misbehaves
//   in a way that only reproduces under the host (inherited proxy env, circuit
//   breaker state, env divergence from `mcp show`, handshake races), set one env
//   var and get an ordered, append-only event log. Every future spawn adapter
//   (Cursor, Windsurf, Claude Code, n8n, CrewAI) hits the same class of bug, so
//   the diagnostic lives in the repo rather than being re-improvised each time.
//
// CONTRACT
//   • OFF BY DEFAULT. Enabled only when AGENT_SHIELD_DEBUG_LOG_PATH is a non-empty
//     path, read ONCE at module load. Unset → `dlog` is a pure no-op: no fs
//     access, no per-call try/overhead beyond a single boolean check.
//   • `dlog(event, fields)` NEVER throws (internal try/catch). Diagnostics must
//     never influence the governance decision — Correctness > Diagnosis.
//   • Synchronous append (`appendFileSync`): the host can kill the process at any
//     moment; a buffered async write would lose the very events we need.
//   • One valid JSON object per line (JSONL). `seq` is a per-process monotonic
//     counter — it is the ordering proof (call #1 vs #2 in the same pid).
//   • Zero dependencies — only node:fs / node:os / node:path builtins.
//
// SECRET HYGIENE (hard rule)
//   Never log the API key, tokens, header values, or request/response bodies.
//   Keys appear only as { present, len }. Proxy URLs are reduced to host:port
//   (embedded user:pass and path stripped). URLs and env-var *names* are safe.
// ─────────────────────────────────────────────────────────────────────────────

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LOG_PATH = (process.env.AGENT_SHIELD_DEBUG_LOG_PATH ?? '').trim();
const ENABLED = LOG_PATH.length > 0;

let seq = 0;

// Best-effort: ensure the parent directory exists so the very first append
// doesn't silently no-op into a missing folder. Never throws (off-path stays
// off; a bad path simply yields no log rather than a crash).
if (ENABLED) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
  } catch {
    /* best-effort only */
  }
}

/** Is file diagnostics active for this process? */
export function isDebugEnabled() {
  return ENABLED;
}

/**
 * Append one diagnostic event as a JSON line. No-op (and zero fs cost) when
 * AGENT_SHIELD_DEBUG_LOG_PATH is unset. Never throws.
 *
 * @param {string} event  - Event name (see GOAL §5: proc_start, mcp_msg,
 *                           breaker, gateway_call_start, gateway_call_end,
 *                           failclosed_emit).
 * @param {object} [fields] - Event-specific, ALREADY secret-safe fields.
 */
export function dlog(event, fields = {}) {
  if (!ENABLED) return;
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      seq: ++seq,
      event,
      ...fields,
    });
    appendFileSync(LOG_PATH, line + '\n', 'utf8');
  } catch {
    // Swallow: a diagnostics IO error must never reach the governance path.
  }
}

/**
 * Secret-safe metadata about a credential: presence + length only. Never the
 * value, never a substring beyond what the caller explicitly chooses.
 * @param {unknown} key
 * @returns {{ present: boolean, len: number }}
 */
export function keyMeta(key) {
  if (typeof key !== 'string' || key.length === 0) return { present: false, len: 0 };
  return { present: true, len: key.length };
}

const PROXY_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

/**
 * Reduce a proxy URL to `protocol//host:port`, dropping any embedded
 * `user:pass@` credentials and path. NO_PROXY-style host lists (not URLs) are
 * returned unchanged (they carry no secret).
 * @param {string} val
 * @returns {string}
 */
export function sanitizeProxyUrl(val) {
  if (typeof val !== 'string' || val === '') return val;
  try {
    const u = new URL(val);
    return `${u.protocol}//${u.host}`; // host includes :port; user:pass + path dropped
  } catch {
    return val; // not a URL (e.g. NO_PROXY list) — no credentials to strip
  }
}

/**
 * Snapshot the proxy-related env vars a spawned process inherited, sanitized.
 * Only present, non-empty vars appear. Decides H2 (inherited proxy) / H4.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, string>}
 */
export function collectProxyEnv(env = process.env) {
  const out = {};
  for (const name of PROXY_VARS) {
    const v = env[name];
    if (v !== undefined && v !== '') {
      out[name] = name.toLowerCase().includes('no_proxy') ? v : sanitizeProxyUrl(v);
    }
  }
  return out;
}
