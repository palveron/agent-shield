// src/client.mjs
// HTTP client for the governance API.
// This is a thin client — NO PII patterns, NO policy evaluation, NO engine logic.
// Only HTTP calls to POST /api/v1/verify and setup endpoints.

import { CircuitBreaker } from './circuit-breaker.mjs';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RETRIES = 2;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_MS = 30000;

export class ShieldClient {
  #apiUrl;
  #apiKey;
  #llmApiKey;
  #timeout;
  #circuitBreaker;

  /**
   * @param {object} options
   * @param {string} options.apiUrl    - Base URL of the governance API (e.g. https://api.palveron.com)
   * @param {string} options.apiKey    - Project API key (pv_live_xxx or pv_test_xxx)
   * @param {string} [options.llmApiKey] - User's LLM API key for BYOM 2-pass analysis
   * @param {number} [options.timeout]   - Request timeout in ms (default: 5000)
   * @param {CircuitBreaker} [options.circuitBreaker] - Inject a pre-built breaker (mainly for tests).
   */
  constructor({ apiUrl, apiKey, llmApiKey, timeout = DEFAULT_TIMEOUT_MS, circuitBreaker } = {}) {
    if (!apiUrl) throw new Error('apiUrl is required');
    if (!apiKey) throw new Error('apiKey is required');

    this.#apiUrl = apiUrl.replace(/\/$/, '');
    this.#apiKey = apiKey;
    this.#llmApiKey = llmApiKey || null;
    this.#timeout = timeout;
    this.#circuitBreaker = circuitBreaker || new CircuitBreaker({
      threshold: CIRCUIT_BREAKER_THRESHOLD,
      resetMs: CIRCUIT_BREAKER_RESET_MS,
    });
  }

  /** @returns {string} Current breaker state — 'CLOSED' | 'OPEN' | 'HALF_OPEN'. */
  get circuitState() {
    return this.#circuitBreaker.state;
  }

  /**
   * Verify a tool call / action before execution.
   * This is the core governance check — every HIGH-RISK tool call goes through here.
   *
   * @param {object} params
   * @param {string} params.agentId   - Agent identifier
   * @param {string} params.toolName  - Tool being called (e.g. "exec", "delete_file")
   * @param {string} params.input     - The input/prompt being sent to the tool
   * @param {string} [params.output]  - The output from the tool (for output governance)
   * @param {object} [params.metadata] - Additional context (risk_level, category, etc.)
   * @returns {Promise<VerifyResponse>}
   */
  async verify({ agentId, toolName, input, output, metadata = {} }) {
    return this.#request('POST', '/api/v1/verify', {
      agent_id: agentId,
      tool_name: toolName,
      input,
      output: output || null,
      metadata: {
        ...metadata,
        source: 'agent-shield',
        llm_api_key: this.#llmApiKey || undefined,
      },
    });
  }

  /**
   * Initialize Shield — activates 8 protection rules for the project.
   * Idempotent — safe to call multiple times.
   *
   * @param {object} params
   * @param {string} params.hostname - Machine hostname for default agent registration
   * @returns {Promise<ShieldSetupResponse>}
   */
  async setupShield({ hostname }) {
    return this.#request('POST', '/api/v1/setup/openclaw-shield', {
      hostname,
      llm_provider: this.#llmApiKey ? 'configured' : null,
    });
  }

  /**
   * Get current Shield status — active policies, 24h stats.
   * @returns {Promise<ShieldStatusResponse>}
   */
  async getShieldStatus() {
    return this.#request('GET', '/api/v1/shield/status');
  }

  /**
   * Health check — verify API is reachable.
   * @returns {Promise<{status: string, version: string}>}
   */
  async health() {
    return this.#request('GET', '/api/v1/health');
  }

  // ─── Internal ──────────────────────────────────────────────────────

  async #request(method, path, body = null) {
    // Circuit breaker: fail open instantly while OPEN, never block the agent.
    if (!this.#circuitBreaker.beforeRequest()) {
      return {
        decision: 'ALLOW',
        reason: 'circuit_open',
        cached: false,
        _fallback: true,
      };
    }

    const url = `${this.#apiUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-API-Key': this.#apiKey,
    };

    // Forward LLM key for BYOM 2-pass analysis
    if (this.#llmApiKey) {
      headers['X-LLM-API-Key'] = this.#llmApiKey;
    }

    const serializedBody = body && method !== 'GET' ? JSON.stringify(body) : undefined;

    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Each attempt gets a fresh timeout signal — reusing one across retries
      // means a single timeout kills every retry.
      const fetchOptions = {
        method,
        headers,
        signal: AbortSignal.timeout(this.#timeout),
      };
      if (serializedBody !== undefined) {
        fetchOptions.body = serializedBody;
      }

      try {
        const response = await fetch(url, fetchOptions);

        if (response.ok) {
          this.#circuitBreaker.recordSuccess();
          return response.json();
        }

        // Don't retry 4xx errors (client errors)
        if (response.status >= 400 && response.status < 500) {
          const errorBody = await response.json().catch(() => ({}));
          throw new ShieldApiError(
            errorBody.error || `API error: ${response.status}`,
            response.status,
            errorBody
          );
        }

        // 5xx — retry
        lastError = new ShieldApiError(
          `Server error: ${response.status}`,
          response.status
        );
      } catch (err) {
        if (err instanceof ShieldApiError) throw err;
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
          lastError = new ShieldApiError('Request timed out', 0);
        } else {
          lastError = new ShieldApiError(
            err.message || 'Network error',
            0
          );
        }
      }

      // Exponential backoff before retry
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
      }
    }

    // All retries exhausted — record one failure against the breaker.
    this.#circuitBreaker.recordFailure();

    // CRITICAL: On failure, ALLOW the action to proceed.
    // Agent-shield must never block the user's workflow due to our own outage.
    return {
      decision: 'ALLOW',
      reason: 'api_unreachable',
      cached: false,
      _fallback: true,
      _error: lastError?.message,
    };
  }
}

export class ShieldApiError extends Error {
  constructor(message, statusCode, body = null) {
    super(message);
    this.name = 'ShieldApiError';
    this.statusCode = statusCode;
    this.body = body;
  }
}
