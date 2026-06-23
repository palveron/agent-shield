// src/error-cause.mjs
// Neutral, dependency-free error-cause utilities used on BOTH the diagnostic
// path (debug-log.mjs) and the live governance path (client.mjs fail policy).
// Kept out of debug-log.mjs so the cause inspection isn't tied to the
// debug-only facility — it must work even when diagnostics are off.

/** Truncate a string to `n` chars (diagnostics/logs never carry full bodies). */
export function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) : str;
}

/**
 * Resolve a thrown error's `cause` chain into a flat, secret-safe array. Node /
 * undici stash the REAL transport reason (ENOTFOUND, ECONNREFUSED,
 * UND_ERR_CONNECT_TIMEOUT, EPERM, UNABLE_TO_VERIFY_LEAF_SIGNATURE, …) in
 * `err.cause`. @palveron/sdk ≥ the Fund-#5 fix preserves it on the
 * PalveronError; older builds dropped it (then the chain is simply empty —
 * callers degrade gracefully, never misclassify).
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

// TLS-trust failure codes — the gateway cert chain could not be verified. The
// dominant real-world cause is an antivirus/firewall performing HTTPS
// inspection with a corporate/AV root CA that lives in the OS trust store but
// not in Node's bundled CA set.
const TLS_TRUST_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export const GATEWAY_TLS_UNTRUSTED_REASON = 'gateway_tls_untrusted';
const TLS_HINT =
  'TLS certificate could not be verified — most likely an antivirus or firewall ' +
  'performing HTTPS inspection with a root CA that Node does not trust by default. ' +
  'Start Node with --use-system-ca (Node ≥22) so it trusts the OS certificate ' +
  'store, or set NODE_EXTRA_CA_CERTS to the inspecting CA. This does NOT disable ' +
  'certificate verification.';

/**
 * Inspect a transport error (and its full cause chain) for a TLS-trust failure.
 * Returns an honest, actionable reason+hint for that class, or `{reason:null}`
 * for genuine network errors (ECONNREFUSED/ENOTFOUND/timeout) so they keep the
 * generic gateway-unavailable label. Never throws.
 * @param {unknown} err
 * @returns {{reason: (string|null), hint: (string|null)}}
 */
export function classifyTransportFailure(err) {
  const codes = [err?.code, ...causeChain(err).map((c) => c.code)].filter(Boolean);
  const isTls = codes.some(
    (c) => TLS_TRUST_CODES.has(c) || c.startsWith('CERT_') || c.startsWith('ERR_TLS_'),
  );
  if (isTls) return { reason: GATEWAY_TLS_UNTRUSTED_REASON, hint: TLS_HINT };
  return { reason: null, hint: null };
}
