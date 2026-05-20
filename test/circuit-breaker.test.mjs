// test/circuit-breaker.test.mjs
// Verifies the client-side fail-open behavior of agent-shield.
// Runs with the built-in Node test runner: `node --test test/` or
// directly as `node test/circuit-breaker.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CircuitBreaker } from '../src/circuit-breaker.mjs';
import { ShieldClient } from '../src/client.mjs';

// ─── Unit tests: CircuitBreaker in isolation ─────────────────────────

test('CircuitBreaker starts CLOSED and lets requests through', () => {
  const cb = new CircuitBreaker({ threshold: 3, resetMs: 30_000 });
  assert.equal(cb.state, 'CLOSED');
  assert.equal(cb.beforeRequest(), true);
});

test('CircuitBreaker opens after 3 consecutive failures', () => {
  const cb = new CircuitBreaker({ threshold: 3, resetMs: 30_000 });
  cb.recordFailure();
  assert.equal(cb.state, 'CLOSED');
  cb.recordFailure();
  assert.equal(cb.state, 'CLOSED');
  cb.recordFailure();
  assert.equal(cb.state, 'OPEN');
  assert.equal(cb.beforeRequest(), false, 'OPEN breaker must short-circuit');
});

test('CircuitBreaker: a success before the 3rd failure resets the counter', () => {
  const cb = new CircuitBreaker({ threshold: 3, resetMs: 30_000 });
  cb.recordFailure();
  cb.recordFailure();
  cb.recordSuccess();
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.state, 'CLOSED', 'success must reset the failure counter');
});

test('CircuitBreaker stays OPEN inside the reset window', () => {
  let now = 1_000;
  const cb = new CircuitBreaker({ threshold: 3, resetMs: 30_000, clock: () => now });
  cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
  assert.equal(cb.state, 'OPEN');

  now = 1_000 + 29_999;
  assert.equal(cb.beforeRequest(), false);
  assert.equal(cb.state, 'OPEN');
});

test('CircuitBreaker transitions OPEN → HALF_OPEN after the reset window, closes on probe success', () => {
  let now = 0;
  const cb = new CircuitBreaker({ threshold: 3, resetMs: 30_000, clock: () => now });
  cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
  assert.equal(cb.state, 'OPEN');

  now = 30_000;
  assert.equal(cb.beforeRequest(), true, 'a single probe is allowed once the window elapses');
  assert.equal(cb.state, 'HALF_OPEN');

  cb.recordSuccess();
  assert.equal(cb.state, 'CLOSED', 'probe success closes the circuit');
});

test('CircuitBreaker: probe failure re-opens the circuit immediately', () => {
  let now = 0;
  const cb = new CircuitBreaker({ threshold: 3, resetMs: 30_000, clock: () => now });
  cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
  now = 30_000;
  cb.beforeRequest();
  assert.equal(cb.state, 'HALF_OPEN');

  cb.recordFailure();
  assert.equal(cb.state, 'OPEN', 'one failed probe re-opens; no second probe yet');
  assert.equal(cb.beforeRequest(), false);
});

// ─── Integration tests: ShieldClient response shape ──────────────────

test('ShieldClient returns { decision: ALLOW, reason: circuit_open, cached: false } when breaker is OPEN', async () => {
  const cb = new CircuitBreaker({ threshold: 3, resetMs: 30_000 });
  cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
  assert.equal(cb.state, 'OPEN');

  // apiUrl is fine because the OPEN breaker short-circuits before any fetch is attempted.
  const client = new ShieldClient({
    apiUrl: 'http://127.0.0.1:1',
    apiKey: 'pv_test_x',
    circuitBreaker: cb,
  });

  const result = await client.verify({ agentId: 't', toolName: 'exec', input: 'rm -rf /' });
  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.reason, 'circuit_open');
  assert.equal(result.cached, false);
  assert.equal(result._fallback, true);
});

test('ShieldClient: 3 consecutive request failures open the circuit; the 4th call short-circuits to ALLOW', async () => {
  // Listening server that returns 500 for every request — exhausts retries and
  // counts as one breaker failure per verify() call.
  const server = createServer((_req, res) => {
    res.statusCode = 500;
    res.end('boom');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    const client = new ShieldClient({
      apiUrl: `http://127.0.0.1:${port}`,
      apiKey: 'pv_test_x',
      timeout: 250,
    });

    for (let i = 0; i < 3; i++) {
      const r = await client.verify({ agentId: 't', toolName: 'exec', input: 'x' });
      assert.equal(r.decision, 'ALLOW', `attempt ${i + 1} must fail open with ALLOW`);
      assert.equal(r.reason, 'api_unreachable', `attempt ${i + 1} reason should be api_unreachable, got ${r.reason}`);
    }

    assert.equal(client.circuitState, 'OPEN', 'breaker should be OPEN after 3 logical failures');

    const short = await client.verify({ agentId: 't', toolName: 'exec', input: 'x' });
    assert.equal(short.decision, 'ALLOW');
    assert.equal(short.reason, 'circuit_open');
    assert.equal(short.cached, false);
    assert.equal(short._fallback, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('ShieldClient: HALF_OPEN probe success after 30 s closes the circuit (simulated clock)', async () => {
  // Use a successful server and an injected breaker with a controllable clock
  // so we don't actually wait 30 seconds.
  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ decision: 'ALLOW', reason: 'ok' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    let now = 0;
    const cb = new CircuitBreaker({ threshold: 3, resetMs: 30_000, clock: () => now });
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
    assert.equal(cb.state, 'OPEN');

    const client = new ShieldClient({
      apiUrl: `http://127.0.0.1:${port}`,
      apiKey: 'pv_test_x',
      circuitBreaker: cb,
      timeout: 500,
    });

    // Inside the window — still short-circuits.
    now = 29_999;
    const blocked = await client.verify({ agentId: 't', toolName: 'exec', input: 'x' });
    assert.equal(blocked.reason, 'circuit_open');

    // Cross the window — next call is the half-open probe; server is healthy → success → CLOSED.
    now = 30_000;
    const probed = await client.verify({ agentId: 't', toolName: 'exec', input: 'x' });
    assert.equal(probed.decision, 'ALLOW');
    assert.equal(probed.reason, 'ok', 'probe succeeded — response should be the server payload');
    assert.equal(client.circuitState, 'CLOSED');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
