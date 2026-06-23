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
import { getServers } from 'node:dns';
import { lookup } from 'node:dns/promises';

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
    // Explicit UTF-8 bytes so non-ASCII in error messages (em dash, etc.) is
    // not mangled by a platform default code page.
    appendFileSync(LOG_PATH, Buffer.from(line + '\n', 'utf8'));
  } catch {
    // Swallow: a diagnostics IO error must never reach the governance path.
  }
}

/** Truncate a string to `n` chars (secret-safe diagnostics never log full bodies). */
function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) : str;
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

/**
 * Resolve a thrown error's `cause` chain into a flat, secret-safe array. Node /
 * undici stash the REAL transport reason (ENOTFOUND, ECONNREFUSED,
 * UND_ERR_CONNECT_TIMEOUT, EPERM, CERT_*) in `err.cause` — the SDK masks the
 * surface as a generic NETWORK_ERROR, so this is how the real reason surfaces.
 * @param {unknown} err
 * @param {number} [maxDepth]
 * @returns {Array<{name:?string,code:?string,errno:?number,syscall:?string,address:?string,port:?(number|string),message:string}>}
 */
export function causeChain(err, maxDepth = 5) {
  const chain = [];
  let cur = err?.cause;
  let depth = 0;
  while (cur && depth < maxDepth) {
    chain.push({
      name: cur.name ?? null,
      code: cur.code ?? null,
      errno: cur.errno ?? null,
      syscall: cur.syscall ?? null,
      address: cur.address ?? null,
      port: cur.port ?? null,
      message: truncate(cur.message, 200),
    });
    // AggregateError (undici connect) hides sub-errors in `.errors` — surface
    // the first so DNS/connect failures aren't swallowed.
    cur = cur.cause ?? (Array.isArray(cur.errors) ? cur.errors[0] : undefined);
    depth++;
  }
  return chain;
}

const OS_ENV_VARS = [
  'SystemRoot',
  'WINDIR',
  'SystemDrive',
  'USERPROFILE',
  'TEMP',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramData',
];

/**
 * Presence-only map of the OS env vars OpenClaw might strip from a child. Values
 * are NEVER logged (paths can be sensitive); only `true/false`, plus PATH length
 * so an empty/stripped PATH is visible. Detects an over-stripped spawn env.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function osEnvPresence(env = process.env) {
  const out = {};
  for (const k of OS_ENV_VARS) out[k] = env[k] !== undefined && env[k] !== '';
  out.PATH = { present: typeof env.PATH === 'string' && env.PATH.length > 0, len: env.PATH ? env.PATH.length : 0 };
  return out;
}

/**
 * TLS / undici env relevant to fetch behaviour. NODE_EXTRA_CA_CERTS is logged as
 * presence + PATH only (never the cert content). UNDICI_* config values are not
 * secrets. Decides TLS-related spawn divergence.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function tlsEnvSnapshot(env = process.env) {
  const undici = {};
  for (const k of Object.keys(env)) {
    if (k.startsWith('UNDICI_')) undici[k] = env[k];
  }
  return {
    NODE_TLS_REJECT_UNAUTHORIZED: env.NODE_TLS_REJECT_UNAUTHORIZED ?? null,
    NODE_EXTRA_CA_CERTS_present: !!env.NODE_EXTRA_CA_CERTS,
    NODE_EXTRA_CA_CERTS_path: env.NODE_EXTRA_CA_CERTS ?? null, // path only, no content
    ...(Object.keys(undici).length ? { undici } : {}),
  };
}

/** The system DNS resolvers, read-only. Never throws. Decides resolver divergence. */
export function dnsServersSafe() {
  try {
    return getServers();
  } catch {
    return null;
  }
}

/**
 * Active, low-level connectivity self-test — ONLY runs when diagnostics are
 * enabled (otherwise a pure no-op: no DNS, no fetch, no network). Each step is
 * isolated in its own try/catch and emits its own event; it can never throw into
 * or delay the governance path beyond its own short timeout. Runs the raw
 * `fetch` OUTSIDE the SDK so the un-masked undici cause chain is visible.
 *
 * @param {string} apiUrl - Gateway base URL (no secret).
 * @returns {Promise<void>}
 */
export async function netSelftest(apiUrl) {
  if (!ENABLED || !apiUrl) return;

  let host;
  try {
    host = new URL(apiUrl).hostname;
  } catch {
    return; // unparseable URL — nothing to probe
  }

  // 1) DNS lookup — does name resolution itself fail in this spawn context?
  const t0 = Date.now();
  try {
    const r = await lookup(host);
    dlog('net_selftest_dns', { host, address: r.address, family: r.family, elapsedMs: Date.now() - t0 });
  } catch (e) {
    dlog('net_selftest_dns', {
      host,
      errName: e?.name ?? null,
      errCode: e?.code ?? null,
      errno: e?.errno ?? null,
      syscall: e?.syscall ?? null,
      elapsedMs: Date.now() - t0,
    });
  }

  // 2) Raw GET /health (idempotent, no mutation) — the un-SDK-masked transport
  //    result. On failure the full cause chain reveals DNS vs connect vs TLS vs
  //    EPERM/egress-block.
  const healthUrl = `${apiUrl.replace(/\/+$/, '')}/health`;
  const t1 = Date.now();
  try {
    const res = await fetch(healthUrl, { method: 'GET', signal: AbortSignal.timeout(3000) });
    dlog('net_selftest_fetch', { url: healthUrl, httpStatus: res.status, elapsedMs: Date.now() - t1 });
  } catch (e) {
    dlog('net_selftest_fetch', {
      url: healthUrl,
      errName: e?.name ?? null,
      errCode: e?.code ?? null,
      errMessage: truncate(e?.message, 200),
      causeChain: causeChain(e),
      elapsedMs: Date.now() - t1,
    });
  }
}
