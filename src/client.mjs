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
import { isFailLoud, transportFallback } from './fail-policy.mjs';

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
  'BLOCKED',
  'MODIFIED',
  'PENDING_APPROVAL',
  'RATE_LIMITED',
]);

export function normalizeDecision(sdkDecision) {
  switch (sdkDecision) {
    case 'BLOCKED':
      return 'BLOCK';
    case 'MODIFIED':
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
    const riskLevel = toolName ? classifyRisk(toolName) : 'MEDIUM';

    try {
      const res = await this.#sdk.verify({
        prompt: input ?? '',
        context: toolName ? { toolName } : undefined,
        metadata: {
          ...metadata,
          ...(agentId ? { agent_id: agentId } : {}),
          source: 'agent-shield',
          risk_level: riskLevel,
        },
      });

      // 429 is surfaced by the SDK as decision RATE_LIMITED (not an exception)
      // on the governed verify path. Treat it as a transport failure, tiered.
      if (res.decision === 'RATE_LIMITED') {
        return transportFallback(riskLevel, {
          errorMessage: 'rate_limited',
          retryAfterMs: res.retryAfterMs,
        });
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
        sdk_decision: res.decision,
        reason: res.reason || null,
        modified_input: res.decision === 'MODIFIED' ? res.output || null : null,
        trace_id: res.traceId || null,
        findings: res.findings || [],
      };
    } catch (err) {
      // FAIL-LOUD: a 400 (broken request body) or 401 (bad key) is our bug or a
      // misconfiguration. Re-throw — never swallow into ALLOW. This is exactly
      // the failure class the old silent fail-open hid.
      if (isFailLoud(err)) throw err;

      // Transport failure (timeout / circuit-open / network / 5xx) → tiered.
      return transportFallback(riskLevel, { errorMessage: err?.message });
    }
  }

  /** Gateway health (hits the real `/health`, via the SDK). */
  async health() {
    return this.#sdk.health();
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
