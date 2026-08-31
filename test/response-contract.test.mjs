// test/response-contract.test.mjs
// Verifies agent-shield honors the gateway Client Response Contract:
// body.decision is the source of truth; the HTTP status only mirrors it.
// A 403 carrying a BLOCKED verdict is a governance result, not an error.
// Runs with the built-in Node test runner: `node --test`.
//
// Adopted from the local-master June commit (cfbde5a) per
// GOAL_AGENT_SHIELD_HAUPTZWEIG_v2 T0b.3. Call-form adaptations only, the
// assertions are unchanged in substance:
//   - The raw gateway verdict now surfaces as `sdk_decision`; the `decision`
//     field carries the agent-facing vocabulary (BLOCK). The original claim
//     "the block verdict must be surfaced, not discarded" is asserted on both.
//   - The circuit-state vocabulary is lowercase in the SDK breaker
//     ('closed' | 'open' | 'half-open').

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ShieldClient } from '../src/client.mjs';

test('ShieldClient: a 403 carrying a BLOCKED verdict is returned as a result, not thrown', async () => {
  // Gateway maps decision:BLOCKED → HTTP 403 WITH a full verify body (Sprint 87).
  const server = createServer((_req, res) => {
    res.statusCode = 403;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ decision: 'BLOCKED', reason: 'policy_block', trace_id: 't_123' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    const client = new ShieldClient({
      apiUrl: `http://127.0.0.1:${port}`,
      apiKey: 'pv_test_x',
      timeout: 500,
    });

    const result = await client.verify({ agentId: 't', toolName: 'exec', input: 'rm -rf /' });
    assert.equal(result.sdk_decision, 'BLOCKED', 'the block verdict must be surfaced, not discarded');
    assert.equal(result.decision, 'BLOCK', 'the agent-facing decision must carry the block');
    assert.equal(result.reason, 'policy_block');
    assert.equal(result._fallback, undefined, 'a real verdict must not look like a fail-open fallback');
    assert.equal(
      client.circuitState,
      'closed',
      'a 403 verdict is a healthy round-trip and must not trip the breaker',
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// The companion assertion — "a bare 403 without a decision in the body must
// throw, not be coerced into a verdict" — is deliberately owned by the SDK
// work stream: the coercion happens inside @palveron/sdk, so the fix and the
// guarding test belong there. The reproduction is preserved verbatim in that
// stream and becomes its regression test.
