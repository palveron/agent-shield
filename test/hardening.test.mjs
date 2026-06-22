// test/hardening.test.mjs
// F5: an unrecognized gateway verdict must NOT be silently allowed — tiered by
// risk (HIGH → fail-closed BLOCK, MEDIUM → ALLOW but flagged as an anomaly).
// F4 (unit): there is no LOW tier and `shouldVerify` is gone (no dead export).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShieldClient } from '../src/client.mjs';
import * as api from '../src/index.mjs';
import { classifyRisk } from '../src/risk-classifier.mjs';

/** Minimal fake SDK that always returns the given verify response. */
function fakeSdk(decision) {
  return {
    verify: async () => ({ decision, traceId: 't_fake', reason: 'fabricated' }),
    diagnostics: () => ({ circuitState: 'closed' }),
  };
}

/** Run with console.warn suppressed (F5 warns to stderr by design). */
async function quiet(fn) {
  const orig = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = orig;
  }
}

test('F5: unknown decision on a HIGH-risk tool → fail-closed BLOCK, flagged anomaly (never ALLOW)', async () => {
  const client = new ShieldClient({ apiUrl: 'http://x', apiKey: 'pv_live_x', sdk: fakeSdk('WAT') });
  const r = await quiet(() => client.verify({ agentId: 'a', toolName: 'exec', input: 'rm -rf /' }));
  assert.equal(r.decision, 'BLOCK');
  assert.equal(r.reason, 'unknown_decision_failclosed');
  assert.equal(r._anomaly, true);
  assert.equal(r.sdk_decision, 'WAT');
});

test('F5: unknown decision on a MEDIUM-risk tool → ALLOW but flagged anomaly', async () => {
  const client = new ShieldClient({ apiUrl: 'http://x', apiKey: 'pv_live_x', sdk: fakeSdk('WAT') });
  const r = await quiet(() => client.verify({ agentId: 'a', toolName: 'read_file', input: 'x' }));
  assert.equal(r.decision, 'ALLOW');
  assert.equal(r.reason, 'unknown_decision');
  assert.equal(r._anomaly, true);
  assert.equal(r.sdk_decision, 'WAT');
});

test('F5: known decisions still pass through normally (no anomaly)', async () => {
  const client = new ShieldClient({ apiUrl: 'http://x', apiKey: 'pv_live_x', sdk: fakeSdk('PASSED') });
  const r = await client.verify({ agentId: 'a', toolName: 'exec', input: 'echo hi' });
  assert.equal(r.decision, 'ALLOW');
  assert.equal(r._anomaly, undefined);
});

test('F4: classifyRisk has no LOW tier — known MEDIUM tools and unknown tools both classify MEDIUM', () => {
  assert.equal(classifyRisk('list_directory'), 'MEDIUM');
  assert.equal(classifyRisk('search_files'), 'MEDIUM');
  assert.equal(classifyRisk('some_unknown_tool'), 'MEDIUM');
  assert.equal(classifyRisk('exec'), 'HIGH');
});

test('F4: shouldVerify is removed (no dead export)', () => {
  assert.equal(api.shouldVerify, undefined, 'shouldVerify must no longer be exported');
});
