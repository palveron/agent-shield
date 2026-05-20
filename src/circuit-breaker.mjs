// src/circuit-breaker.mjs
// Client-side fail-open circuit breaker for agent-shield.
//
// Three states: CLOSED → OPEN → HALF_OPEN → (CLOSED | OPEN)
//   CLOSED:    requests pass through; consecutive failures are counted.
//   OPEN:      requests short-circuit and the caller must fail open
//              (return ALLOW). After `resetMs` elapses, the next
//              beforeRequest() probe transitions to HALF_OPEN.
//   HALF_OPEN: exactly one probe request is allowed through. Its
//              outcome decides the next state — success closes the
//              circuit, failure re-opens it immediately.
//
// The `clock` constructor option makes the time source injectable so
// tests don't need fake timers.

export class CircuitBreaker {
  #threshold;
  #resetMs;
  #clock;
  #state;
  #failures;
  #openedAt;

  /**
   * @param {object} [options]
   * @param {number} [options.threshold=3]  Consecutive failures that open the circuit.
   * @param {number} [options.resetMs=30000] Time the circuit stays OPEN before a probe is allowed.
   * @param {() => number} [options.clock]   Monotonic-ish time source (defaults to Date.now).
   */
  constructor({ threshold = 3, resetMs = 30000, clock = Date.now } = {}) {
    this.#threshold = threshold;
    this.#resetMs = resetMs;
    this.#clock = clock;
    this.#state = 'CLOSED';
    this.#failures = 0;
    this.#openedAt = 0;
  }

  get state() {
    return this.#state;
  }

  /**
   * Ask the breaker whether the next request should be allowed.
   * Side effect: if OPEN and the reset window has elapsed, transitions to HALF_OPEN
   * and returns true (the single probe).
   * @returns {boolean} true → caller proceeds with the real request; false → fail open.
   */
  beforeRequest() {
    if (this.#state === 'OPEN') {
      if (this.#clock() - this.#openedAt >= this.#resetMs) {
        this.#state = 'HALF_OPEN';
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess() {
    this.#state = 'CLOSED';
    this.#failures = 0;
  }

  recordFailure() {
    if (this.#state === 'HALF_OPEN') {
      this.#open();
      return;
    }
    this.#failures++;
    if (this.#failures >= this.#threshold) {
      this.#open();
    }
  }

  #open() {
    this.#state = 'OPEN';
    this.#openedAt = this.#clock();
    this.#failures = this.#threshold;
  }
}
