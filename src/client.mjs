// src/client.mjs
// HTTP client for the governance API.
// This is a thin client — NO PII patterns, NO policy evaluation, NO engine logic.
// Only HTTP calls to POST /api/v1/verify and setup endpoints.

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RETRIES = 2;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 30000;

export class ShieldClient {
  #apiUrl;
  #apiKey;
  #llmApiKey;
  #timeout;
  #circuitBreaker;

  /**
   * @param {object} options
   * @param {string} options.apiUrl    - Base URL of the governance API (e.g. https://api.PLACEHOLDER_DOMAIN)
   * @param {string} options.apiKey    - Project API key (vx_live_xxx or vx_test_xxx)
   * @param {string} [options.llmApiKey] - User's LLM API key for BYOM 2-pass analysis
   * @param {number} [options.timeout]   - Request timeout in ms (default: 5000)
   */
  constructor({ apiUrl, apiKey, llmApiKey, timeout = DEFAULT_TIMEOUT_MS }) {
    if (!apiUrl) throw new Error('apiUrl is required');
    if (!apiKey) throw new Error('apiKey is required');

    this.#apiUrl = apiUrl.replace(/\/$/, '');
    this.#apiKey = apiKey;
    this.#llmApiKey = llmApiKey || null;
    this.#timeout = timeout;
    this.#circuitBreaker = {
      failures: 0,
      lastFailure: 0,
      isOpen: false,
    };
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
    // Circuit breaker check
    if (this.#circuitBreaker.isOpen) {
      const elapsed = Date.now() - this.#circuitBreaker.lastFailure;
      if (elapsed < CIRCUIT_BREAKER_RESET_MS) {
        return {
          decision: 'ALLOW',
          reason: 'circuit_breaker_open',
          _fallback: true,
        };
      }
      // Reset circuit breaker — try again
      this.#circuitBreaker.isOpen = false;
      this.#circuitBreaker.failures = 0;
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

    const fetchOptions = {
      method,
      headers,
      signal: AbortSignal.timeout(this.#timeout),
    };

    if (body && method !== 'GET') {
      fetchOptions.body = JSON.stringify(body);
    }

    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, fetchOptions);

        if (response.ok) {
          this.#circuitBreaker.failures = 0;
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

    // All retries exhausted — update circuit breaker
    this.#circuitBreaker.failures++;
    this.#circuitBreaker.lastFailure = Date.now();
    if (this.#circuitBreaker.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.#circuitBreaker.isOpen = true;
    }

    // CRITICAL: On failure, ALLOW the action to proceed.
    // Agent-shield must never block the user's workflow due to our own outage.
    return {
      decision: 'ALLOW',
      reason: 'api_unreachable',
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
