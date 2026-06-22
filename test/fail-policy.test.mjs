// test/fail-policy.test.mjs
// Proves the tiered fail policy (Block B3): the launch-blocking silent-ALLOW is
// gone. Contract/auth failures fail LOUD (throw); transport failures are tiered
// by risk (HIGH → fail-closed BLOCK, MEDIUM/LOW → fail-open ALLOW); the
// AGENT_SHIELD_FAIL_CLOSED override forces fail-closed for all levels.
//
// Runs with the built-in Node test runner: `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ShieldClient } from '../src/client.mjs';
import {
  transportFallback,
  isFailLoud,
  failClosedOverride,
  FAIL_CLOSED_REASON,
  FAIL_OPEN_REASON,
} from '../src/fail-policy.mjs';
import {
  PalveronValidationError,
  PalveronAuthenticationError,
  PalveronTimeoutError,
} from '@palveron/sdk';

/** Server that always replies with the given status/body. */
async function withServer(status, json, run) {
  const server = createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(json));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ─── Unit: pure fail-policy ──────────────────────────────────────────

test('isFailLoud: validation + auth errors are fail-loud; transport errors are not', () => {
  assert.equal(isFailLoud(new PalveronValidationError('bad body')), true);
  assert.equal(isFailLoud(new PalveronAuthenticationError('bad key')), true);
  assert.equal(isFailLoud(new PalveronTimeoutError(1000)), false);
  assert.equal(isFailLoud(new Error('network')), false);
});

test('transportFallback: HIGH risk fails CLOSED, MEDIUM/LOW fail OPEN', () => {
  assert.deepEqual(
    { d: transportFallback('HIGH', { env: {} }).decision, r: transportFallback('HIGH', { env: {} }).reason },
    { d: 'BLOCK', r: FAIL_CLOSED_REASON },
  );
  assert.equal(transportFallback('MEDIUM', { env: {} }).decision, 'ALLOW');
  assert.equal(transportFallback('MEDIUM', { env: {} }).reason, FAIL_OPEN_REASON);
  assert.equal(transportFallback('LOW', { env: {} }).decision, 'ALLOW');
});

test('transportFallback: AGENT_SHIELD_FAIL_CLOSED=true forces BLOCK for all levels', () => {
  const env = { AGENT_SHIELD_FAIL_CLOSED: 'true' };
  assert.equal(transportFallback('MEDIUM', { env }).decision, 'BLOCK');
  assert.equal(transportFallback('LOW', { env }).decision, 'BLOCK');
});

test('failClosedOverride parses truthy/falsey correctly', () => {
  assert.equal(failClosedOverride({ AGENT_SHIELD_FAIL_CLOSED: 'true' }), true);
  assert.equal(failClosedOverride({ AGENT_SHIELD_FAIL_CLOSED: 'TRUE' }), true);
  assert.equal(failClosedOverride({ AGENT_SHIELD_FAIL_CLOSED: 'false' }), false);
  assert.equal(failClosedOverride({}), false);
});

// ─── Integration: ShieldClient honors the policy ─────────────────────

test('HIGH-risk transport failure (5xx) → fail-CLOSED BLOCK, never silent ALLOW', async () => {
  const result = await withServer(500, { error: 'boom' }, async (baseUrl) => {
    const client = new ShieldClient({ apiUrl: baseUrl, apiKey: 'pv_live_x', maxRetries: 0, timeout: 400 });
    return client.verify({ agentId: 'a', toolName: 'exec', input: 'rm -rf /' });
  });
  assert.equal(result.decision, 'BLOCK', 'a dangerous tool during our outage MUST be blocked');
  assert.equal(result.reason, FAIL_CLOSED_REASON);
  assert.equal(result._fallback, true);
});

test('MEDIUM-risk transport failure (5xx) → fail-OPEN ALLOW', async () => {
  const result = await withServer(500, { error: 'boom' }, async (baseUrl) => {
    const client = new ShieldClient({ apiUrl: baseUrl, apiKey: 'pv_live_x', maxRetries: 0, timeout: 400 });
    return client.verify({ agentId: 'a', toolName: 'read_file', input: 'cat config' });
  });
  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.reason, FAIL_OPEN_REASON);
});

test('validation error (HTTP 400) → FAIL-LOUD: throws, does NOT return ALLOW', async () => {
  await withServer(400, { error: 'missing field prompt', field: 'prompt' }, async (baseUrl) => {
    const client = new ShieldClient({ apiUrl: baseUrl, apiKey: 'pv_live_x', maxRetries: 0 });
    await assert.rejects(
      () => client.verify({ agentId: 'a', toolName: 'exec', input: 'x' }),
      (err) => {
        assert.ok(err instanceof PalveronValidationError, 'must be a PalveronValidationError');
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });
});

test('auth error (HTTP 401) → FAIL-LOUD: throws, does NOT return ALLOW', async () => {
  await withServer(401, { error: 'bad key' }, async (baseUrl) => {
    const client = new ShieldClient({ apiUrl: baseUrl, apiKey: 'pv_live_x', maxRetries: 0 });
    await assert.rejects(
      () => client.verify({ agentId: 'a', toolName: 'exec', input: 'x' }),
      (err) => {
        assert.ok(err instanceof PalveronAuthenticationError);
        assert.equal(err.statusCode, 401);
        return true;
      },
    );
  });
});

test('rate-limit (HTTP 429) on HIGH risk → tiered fail-closed BLOCK with retry hint', async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 429;
    res.setHeader('content-type', 'application/json');
    res.setHeader('retry-after', '2');
    res.end(JSON.stringify({ error: 'rate limited' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const client = new ShieldClient({
      apiUrl: `http://127.0.0.1:${port}`,
      apiKey: 'pv_live_x',
      maxRetries: 0,
      timeout: 400,
    });
    const result = await client.verify({ agentId: 'a', toolName: 'exec', input: 'rm -rf /' });
    assert.equal(result.decision, 'BLOCK');
    assert.equal(result.reason, FAIL_CLOSED_REASON);
    assert.equal(result.retry_after_ms, 2000);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('override AGENT_SHIELD_FAIL_CLOSED=true: MEDIUM-risk transport failure → BLOCK', async () => {
  const prev = process.env.AGENT_SHIELD_FAIL_CLOSED;
  process.env.AGENT_SHIELD_FAIL_CLOSED = 'true';
  try {
    const result = await withServer(500, { error: 'boom' }, async (baseUrl) => {
      const client = new ShieldClient({ apiUrl: baseUrl, apiKey: 'pv_live_x', maxRetries: 0, timeout: 400 });
      return client.verify({ agentId: 'a', toolName: 'read_file', input: 'x' });
    });
    assert.equal(result.decision, 'BLOCK');
    assert.equal(result.reason, FAIL_CLOSED_REASON);
  } finally {
    if (prev === undefined) delete process.env.AGENT_SHIELD_FAIL_CLOSED;
    else process.env.AGENT_SHIELD_FAIL_CLOSED = prev;
  }
});
