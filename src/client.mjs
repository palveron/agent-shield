// src/client.mjs
// agent-shield HTTP facade over @palveron/sdk.
//
// Single Source of Truth for the verify contract (Analysis §1.2 / Block B1):
// agent-shield no longer hand-builds the /verify request body. @palveron/sdk
// owns the wire format (`prompt` top-level, `context.tool_name`,
// `metadata` passthrough), the retry logic, and the circuit breaker. Two
// implementations of the same contract were the root cause of the
// launch-blocking silent-ALLOW bug; collapsing them to one removes the drift.
//
// agent-shield keeps only the OpenClaw-specific concerns:
//   • the tiered fail policy (Block B3, src/fail-policy.mjs);
//   • the OpenClaw Shield setup/status endpoints the generic SDK does not
//     cover — thin helpers that reuse the SDK auth scheme and THROW on
//     non-2xx (control-plane calls are never silent);
//   • normalization of the SDK's canonical decisions into the
//     ALLOW / BLOCK / MODIFY / APPROVAL vocabulary SKILL.md and the MCP tool
//     speak.

import { Palveron } from '@palveron/sdk';
import { classifyRisk } from './risk-classifier.mjs';
import { normalizeToolName } from './tool-normalization.mjs';
import { isFailLoud, transportFallback } from './fail-policy.mjs';
import { dlog, causeChain } from './debug-log.mjs';
import { classifyTransportFailure } from './error-cause.mjs';

/**
 * Classify a thrown SDK error into a diagnostic `outcome` for the spawn log.
 * Logging-only — does NOT influence the fail policy (which keys off isFailLoud /
 * the typed errors directly). Distinguishing `breaker_open_shortcircuit` (no
 * network attempt) from a real `transport_error`/`timeout` is what decides
 * H1 vs H2/H3 in the Fund-#5 diagnosis.
 * @param {unknown} err
 * @returns {'breaker_open_shortcircuit'|'timeout'|'http_error'|'transport_error'}
 */
function classifyErrorOutcome(err) {
  switch (err?.name) {
    case 'PalveronCircuitOpenError':
      return 'breaker_open_shortcircuit';
    case 'PalveronTimeoutError':
      return 'timeout';
    case 'PalveronValidationError':
    case 'PalveronAuthenticationError':
      return 'http_error';
    default:
      return 'transport_error';
  }
}

const DEFAULT_TIMEOUT_MS = 5000;
const SHIELD_REQUEST_TIMEOUT_MS = 10000;

/**
 * Map a canonical SDK decision (Sprint 87 gateway vocabulary) to the
 * agent-facing ALLOW / BLOCK / MODIFY / APPROVAL the MCP tool returns.
 * @param {string} sdkDecision
 * @returns {'ALLOW'|'BLOCK'|'MODIFY'|'APPROVAL'}
 */
/**
 * The SDK/gateway decisions `verify` explicitly understands. Anything outside
 * this set is an anomaly (e.g. a future, more restrictive verdict) and is
 * handled risk-tiered in `verify` — never silently allowed (F5).
 */
export const KNOWN_SDK_DECISIONS = new Set([
  'PASSED',
  'ALLOWED',
  'FLAGGED',
  'POLICY_CHANGE',
  'MODIFIED',
  'ANONYMIZED',
  'REDACTED',
  'BLOCKED',
  'PENDING_APPROVAL',
  'RATE_LIMITED',
]);

/**
 * Decisions where the gateway proceeds but returns a masked/pseudonymized
 * payload the agent must use instead of its original input. All three map to
 * agent-facing MODIFY and carry the replacement text in `res.output`:
 *   • MODIFIED   — Entity-Gate modification
 *   • ANONYMIZED — PII pseudonymized (reversible, PBEG token vault)
 *   • REDACTED   — credential irreversibly removed
 * The gateway sends exactly ONE of ANONYMIZED/REDACTED (verify_pipeline.rs:391
 * "credential dominates: REDACTED wins over ANONYMIZED"), so they are distinct
 * verdicts, not one with a flag.
 */
export const MASKING_DECISIONS = new Set(['MODIFIED', 'ANONYMIZED', 'REDACTED']);

/**
 * Human-readable `reason` fallbacks used ONLY when the gateway supplies none.
 * A real gateway `reason` always wins — these never overwrite it. They make the
 * reversible-vs-irreversible compliance nuance legible at the agent/trace level.
 */
const MASKING_REASON_DEFAULTS = {
  ANONYMIZED: 'PII pseudonymized (reversible) — use the masked modified_input',
  REDACTED: 'Credential removed (irreversible) — use the masked modified_input',
};

export function normalizeDecision(sdkDecision) {
  switch (sdkDecision) {
    case 'BLOCKED':
      return 'BLOCK';
    case 'MODIFIED':
    // ANONYMIZED/REDACTED unify with MODIFIED as agent-facing MODIFY: the agent
    // proceeds with the masked `modified_input`, identical to the Gateway-Proxy
    // (proxy.rs:351) and LangChain paths. The compliance nuance lives in
    // `sdk_decision` + `reason`, not in a fifth agent action.
    case 'ANONYMIZED':
    case 'REDACTED':
      return 'MODIFY';
    case 'PENDING_APPROVAL':
      return 'APPROVAL';
    case 'PASSED':
    case 'ALLOWED':
    case 'FLAGGED':
    case 'POLICY_CHANGE':
      return 'ALLOW';
    default:
      // Only the known success classes above reach ALLOW. Unknown verdicts are
      // intercepted upstream in `verify` (F5) and never reach this default for
      // a real call — they are NOT silently allowed.
      return 'ALLOW';
  }
}

export class ShieldClient {
  #sdk;
  #apiUrl;
  #apiKey;
  #timeoutMs;

  /**
   * @param {object} options
   * @param {string} options.apiUrl  - Base URL of the governance gateway.
   * @param {string} options.apiKey  - Project API key (pv_live_*).
   * @param {number} [options.timeout]    - Per-request timeout in ms (default 5000).
   * @param {number} [options.maxRetries] - SDK retry attempts (default: SDK default).
   * @param {import('@palveron/sdk').Palveron} [options.sdk] - Inject a pre-built
   *   SDK client (mainly for tests).
   */
  constructor({ apiUrl, apiKey, timeout = DEFAULT_TIMEOUT_MS, maxRetries, sdk } = {}) {
    if (!apiUrl) throw new Error('apiUrl is required');
    if (!apiKey) throw new Error('apiKey is required');

    this.#apiUrl = apiUrl.replace(/\/+$/, '');
    this.#apiKey = apiKey;
    this.#timeoutMs = timeout; // retained for diagnostics only (timeout outcome logging)
    // Note: there is intentionally NO BYOM LLM-key forwarding. The gateway
    // reads the BYOM provider key from the project record (Project.openaiKey,
    // configured in the dashboard → Settings → Neural Gateway). Forwarding a
    // user LLM key per request was dead weight the gateway never read.
    this.#sdk =
      sdk ||
      new Palveron({
        apiKey,
        baseUrl: this.#apiUrl,
        timeout,
        ...(maxRetries !== undefined ? { maxRetries } : {}),
      });
  }

  /** Current SDK circuit-breaker state — 'closed' | 'open' | 'half-open'. */
  get circuitState() {
    return this.#sdk.diagnostics().circuitState;
  }

  /**
   * Read the SDK circuit state without ever throwing (diagnostics only).
   * The breaker is SDK-internal (threshold 5 / cooldown 30s); the only thing
   * agent-shield can observe is its state via diagnostics() + the
   * PalveronCircuitOpenError thrown on a short-circuited call.
   * @returns {string}
   */
  #circuitStateSafe() {
    try {
      return this.#sdk.diagnostics().circuitState;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Emit a `breaker` event when the observed SDK circuit state changed across a
   * call (e.g. closed→open when this call tripped it, or open→half-open after
   * cooldown). `observed` carries the call result for context. Returns the new
   * state. Diagnostics only — does not touch breaker behaviour.
   * @param {string} before
   * @param {string} observed
   * @returns {string}
   */
  #emitBreakerDelta(before, observed) {
    const after = this.#circuitStateSafe();
    if (after !== before) {
      dlog('breaker', { from: before, to: after, observed });
    }
    return after;
  }

  /**
   * Verify a tool call / action before execution. Every HIGH-RISK tool call
   * goes through here. Applies the tiered fail policy (B3): a genuine block
   * surfaces as BLOCK; a contract/auth failure THROWS (fail-loud); a transport
   * failure falls back tiered by risk (HIGH → BLOCK, MEDIUM/LOW → ALLOW).
   *
   * @param {object} params
   * @param {string} [params.agentId]
   * @param {string} [params.toolName]
   * @param {string} params.input
   * @param {object} [params.metadata]
   * @returns {Promise<{decision:'ALLOW'|'BLOCK'|'MODIFY'|'APPROVAL', reason:(string|null), modified_input?:(string|null), trace_id?:(string|null), findings?:Array, _fallback?:boolean}>}
   */
  async verify({ agentId, toolName, input, metadata = {} }) {
    // Fail-policy + risk_level + all logs key off the NATIVE tool name — never
    // overwrite `toolName` (BEFUND Strang B classifyRisk-Trennlinie).
    const riskLevel = toolName ? classifyRisk(toolName) : 'MEDIUM';
    // Only the gateway-bound capability key is normalized to `prefix:action`.
    const gatewayToolName = toolName ? normalizeToolName(toolName) : undefined;

    // ── Diagnostics (no-op unless AGENT_SHIELD_DEBUG_LOG_PATH set) ──
    // `attempt: 0` is the agent-shield-level call; the SDK does its own internal
    // retries which are not separately visible here. The breaker state captured
    // BEFORE the call is what distinguishes H1 (open → short-circuit, no network)
    // from a fresh transport failure.
    const verifyUrl = `${this.#apiUrl}/api/v1/verify`;
    const breakerBefore = this.#circuitStateSafe();
    const startedAt = Date.now();
    dlog('gateway_call_start', { kind: 'verify', url: verifyUrl, attempt: 0, breakerState: breakerBefore });

    try {
      const res = await this.#sdk.verify({
        prompt: input ?? '',
        context: gatewayToolName ? { toolName: gatewayToolName } : undefined,
        metadata: {
          ...metadata,
          ...(agentId ? { agent_id: agentId } : {}),
          source: 'agent-shield',
          risk_level: riskLevel,
        },
      });

      this.#emitBreakerDelta(breakerBefore, 'http_ok');
      dlog('gateway_call_end', {
        kind: 'verify',
        url: verifyUrl,
        attempt: 0,
        outcome: 'http_ok',
        httpStatus: res.decision === 'RATE_LIMITED' ? 429 : 200,
        decision: res.decision ?? null,
        elapsedMs: Date.now() - startedAt,
      });

      // 429 is surfaced by the SDK as decision RATE_LIMITED (not an exception)
      // on the governed verify path. Treat it as a transport failure, tiered.
      if (res.decision === 'RATE_LIMITED') {
        const fb = transportFallback(riskLevel, {
          errorMessage: 'rate_limited',
          retryAfterMs: res.retryAfterMs,
        });
        dlog('failclosed_emit', { reason: fb.reason, decision: fb.decision, branch: 'rate_limited', riskLevel });
        return fb;
      }

      // F5: an unrecognized verdict (e.g. a future, stricter decision) must not
      // be waved through. For a security tool, "unknown → ALLOW" is the wrong
      // direction. Tier it: HIGH-risk fails closed; lower risk allows but flags
      // the anomaly loudly so it surfaces in logs and traces.
      if (!KNOWN_SDK_DECISIONS.has(res.decision)) {
        console.warn(
          `[agent-shield] unrecognized gateway decision: ${JSON.stringify(res.decision)} (riskLevel=${riskLevel})`,
        );
        if (riskLevel === 'HIGH') {
          return {
            decision: 'BLOCK',
            reason: 'unknown_decision_failclosed',
            _anomaly: true,
            sdk_decision: res.decision,
            trace_id: res.traceId || null,
          };
        }
        return {
          decision: 'ALLOW',
          reason: 'unknown_decision',
          _anomaly: true,
          sdk_decision: res.decision,
          trace_id: res.traceId || null,
        };
      }

      return {
        decision: normalizeDecision(res.decision),
        // Preserve the exact gateway verdict so the dashboard/trace match the
        // engine decision (ANONYMIZED vs REDACTED stays visible downstream).
        sdk_decision: res.decision,
        // Gateway reason wins; fall back to a nuance-preserving default only for
        // masking verdicts that arrived without one.
        reason: res.reason || MASKING_REASON_DEFAULTS[res.decision] || null,
        // Every masking verdict (MODIFIED/ANONYMIZED/REDACTED) carries its
        // replacement text in `res.output` — pass it through so MODIFY is never
        // returned without the substitute the agent must use.
        modified_input: MASKING_DECISIONS.has(res.decision) ? res.output || null : null,
        trace_id: res.traceId || null,
        findings: res.findings || [],
      };
    } catch (err) {
      const outcome = classifyErrorOutcome(err);
      this.#emitBreakerDelta(breakerBefore, err?.name || 'error');
      dlog('gateway_call_end', {
        kind: 'verify',
        url: verifyUrl,
        attempt: 0,
        outcome,
        errName: err?.name ?? null,
        errCode: err?.code ?? null,
        errMessage: String(err?.message ?? '').slice(0, 200),
        // @palveron/sdk ≥1.2.0 preserves the original transport error on the
        // PalveronError's `cause` (the NETWORK_ERROR no longer discards it), so
        // causeChain here surfaces the real undici reason (TLS-trust / connect /
        // DNS) directly off the SDK error. net_selftest_fetch (raw fetch outside
        // the SDK) remains as an independent cross-check. Older SDKs dropped the
        // cause → the chain was simply empty and callers degraded gracefully.
        errStack: String(err?.stack ?? '').slice(0, 600),
        causeChain: causeChain(err),
        ...(outcome === 'timeout' ? { timeoutMs: this.#timeoutMs } : {}),
        elapsedMs: Date.now() - startedAt,
      });

      // FAIL-LOUD: a 400 (broken request body) or 401 (bad key) is our bug or a
      // misconfiguration. Re-throw — never swallow into ALLOW. This is exactly
      // the failure class the old silent fail-open hid.
      if (isFailLoud(err)) throw err;

      // Transport failure (timeout / circuit-open / network / 5xx) → tiered.
      // Inspect the cause chain for a TLS-trust failure (HTTPS-inspecting AV /
      // firewall): keep the fail-CLOSED BLOCK, but replace the opaque
      // gateway_unavailable_failclosed with an honest, actionable reason+hint so
      // the user sees WHY and HOW to fix it instead of a bare BLOCK. Genuine
      // connect/DNS/timeout failures keep the generic reason.
      const { reason: tlsReason, hint } = classifyTransportFailure(err);
      const fb = transportFallback(riskLevel, {
        errorMessage: err?.message,
        ...(tlsReason ? { reason: tlsReason, hint } : {}),
      });
      // failclosed_emit closes the causal chain: this branch is what produced
      // the fail-closed verdict. `branch` names the outcome that caused it —
      // breaker_open_shortcircuit (H1) vs a real transport_error/timeout (H2/H3).
      dlog('failclosed_emit', { reason: fb.reason, decision: fb.decision, branch: outcome, riskLevel, errName: err?.name ?? null });
      return fb;
    }
  }

  /** Gateway health (hits the real `/health`, via the SDK). */
  async health() {
    const healthUrl = `${this.#apiUrl}/health`;
    const breakerBefore = this.#circuitStateSafe();
    const startedAt = Date.now();
    dlog('gateway_call_start', { kind: 'health', url: healthUrl, attempt: 0, breakerState: breakerBefore });
    try {
      const res = await this.#sdk.health();
      this.#emitBreakerDelta(breakerBefore, 'http_ok');
      dlog('gateway_call_end', { kind: 'health', url: healthUrl, attempt: 0, outcome: 'http_ok', elapsedMs: Date.now() - startedAt });
      return res;
    } catch (err) {
      const outcome = classifyErrorOutcome(err);
      this.#emitBreakerDelta(breakerBefore, err?.name || 'error');
      dlog('gateway_call_end', {
        kind: 'health',
        url: healthUrl,
        attempt: 0,
        outcome,
        errName: err?.name ?? null,
        errCode: err?.code ?? null,
        errMessage: String(err?.message ?? '').slice(0, 200),
        errStack: String(err?.stack ?? '').slice(0, 600),
        causeChain: causeChain(err),
        elapsedMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  /** List active policies (via the SDK). */
  async listPolicies(env) {
    return this.#sdk.listPolicies(env);
  }

  // ── OpenClaw Shield endpoints (not part of the generic SDK) ───────────────
  // Thin control-plane helpers. They reuse the SDK's Bearer auth scheme and
  // THROW on any non-2xx response — setup and status are never silent.

  /**
   * Initialize the OpenClaw Shield for the project (idempotent server-side).
   * @param {object} params
   * @param {string} params.hostname
   * @returns {Promise<object>} ShieldSetupResponse
   */
  async setupShield({ hostname }) {
    return this.#shieldRequest('POST', '/api/v1/setup/openclaw-shield', { hostname });
  }

  /**
   * Current Shield status — active policies + 24h stats.
   * @returns {Promise<object>} ShieldStatusResponse
   */
  async getShieldStatus() {
    return this.#shieldRequest('GET', '/api/v1/shield/status');
  }

  async #shieldRequest(method, path, body) {
    let res;
    try {
      res = await fetch(`${this.#apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(SHIELD_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Shield ${method} ${path} failed: ${err?.message || err}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let detail = text;
      try {
        detail = JSON.parse(text).error || text;
      } catch {
        // keep raw text
      }
      throw new Error(
        `Shield ${method} ${path} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
      );
    }

    return res.json();
  }
}
