// src/fail-policy.mjs
// Tiered fail policy for agent-shield governance calls (Analysis Block G / B3).
//
// The OLD client failed OPEN on every error: a malformed request or a gateway
// outage silently returned `ALLOW`, leaving the agent ungoverned exactly when
// governance mattered most. That was the launch-blocking bug — a contract drift
// hid behind a blanket fail-open. This module replaces it with an honest,
// tiered policy built on the typed errors of @palveron/sdk:
//
//   • Contract / auth failures (400 validation, 401 auth) → FAIL-LOUD.
//     These are our own bug or a misconfiguration, never a reason to wave a
//     dangerous action through. The caller re-throws so the CLI surfaces the
//     error and the MCP server reports an explicit ERROR — never ALLOW.
//
//   • Transport failures (timeout, circuit-open, network, 5xx, 429 rate-limit)
//     → TIERED by the local risk classifier:
//       - HIGH risk (shell / exec / delete / git_push / destructive / secret
//         exfiltration) → FAIL-CLOSED: decision BLOCK. If our gateway is down we
//         do not let a dangerous action run unchecked.
//       - MEDIUM / LOW risk → FAIL-OPEN: decision ALLOW, so a transient outage
//         never blocks ordinary work.
//
//   • Override: AGENT_SHIELD_FAIL_CLOSED=true forces fail-closed for ALL risk
//     levels on transport failure (maximum safety; availability traded away).
//
// Decision vocabulary here is the agent-facing one (ALLOW / BLOCK), matching
// SKILL.md and the MCP `governance_check` contract.

import {
  PalveronValidationError,
  PalveronAuthenticationError,
} from '@palveron/sdk';

export const FAIL_CLOSED_REASON = 'gateway_unavailable_failclosed';
export const FAIL_OPEN_REASON = 'gateway_unavailable_failopen';

/**
 * Is the global fail-closed override active?
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function failClosedOverride(env = process.env) {
  return String(env.AGENT_SHIELD_FAIL_CLOSED ?? '').trim().toLowerCase() === 'true';
}

/**
 * Is this a FAIL-LOUD error (contract / auth) that must never be swallowed
 * into an ALLOW? These indicate a broken request or bad credentials, not a
 * transient outage.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isFailLoud(err) {
  return (
    err instanceof PalveronValidationError ||
    err instanceof PalveronAuthenticationError
  );
}

/**
 * Decide the fallback verdict for a TRANSPORT failure, tiered by risk.
 * Returns a synthetic verify-result; never throws.
 *
 * @param {'HIGH'|'MEDIUM'|'LOW'} riskLevel
 * @param {object} [opts]
 * @param {string} [opts.errorMessage] - Diagnostic message (attached as `_error`).
 * @param {number} [opts.retryAfterMs] - Rate-limit hint to surface to the caller.
 * @param {NodeJS.ProcessEnv} [opts.env] - Injectable env (for tests).
 * @returns {{decision: 'ALLOW'|'BLOCK', reason: string, _fallback: true, _error?: string, retry_after_ms?: number}}
 */
export function transportFallback(riskLevel, opts = {}) {
  const failClosed = failClosedOverride(opts.env) || riskLevel === 'HIGH';
  if (failClosed) {
    return {
      decision: 'BLOCK',
      reason: FAIL_CLOSED_REASON,
      _fallback: true,
      ...(opts.errorMessage ? { _error: opts.errorMessage } : {}),
      ...(opts.retryAfterMs !== undefined ? { retry_after_ms: opts.retryAfterMs } : {}),
    };
  }
  return {
    decision: 'ALLOW',
    reason: FAIL_OPEN_REASON,
    _fallback: true,
    ...(opts.errorMessage ? { _error: opts.errorMessage } : {}),
    ...(opts.retryAfterMs !== undefined ? { retry_after_ms: opts.retryAfterMs } : {}),
  };
}
