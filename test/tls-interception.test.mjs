// test/tls-interception.test.mjs
// Fund #5 fix: a TLS-trust transport failure (HTTPS-inspecting AV/firewall whose
// root CA Node doesn't trust) must STILL fail closed on HIGH risk, but surface an
// honest, actionable reason (`gateway_tls_untrusted`) + hint instead of the
// opaque `gateway_unavailable_failclosed`. Genuine connect failures keep the
// generic reason (no mis-reframe).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShieldClient } from '../src/client.mjs';
import { classifyTransportFailure, causeChain } from '../src/error-cause.mjs';

/** Build a post-fix-SDK-shaped error: PalveronError(NETWORK_ERROR) whose cause
 *  is the `TypeError: fetch failed`, whose own cause is the real undici reason. */
function networkError(causeCode) {
  const undici = Object.assign(new Error(`tls/${causeCode}`), { code: causeCode });
  const fetchTypeError = new TypeError('fetch failed', { cause: undici });
  const e = new Error('Network error — could not reach gateway');
  e.name = 'PalveronError';
  e.code = 'NETWORK_ERROR';
  e.cause = fetchTypeError;
  return e;
}

function throwingSdk(err) {
  return {
    verify: async () => {
      throw err;
    },
    diagnostics: () => ({ circuitState: 'closed' }),
  };
}

test('classifyTransportFailure detects a TLS-trust code anywhere in the cause chain', () => {
  const r = classifyTransportFailure(networkError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'));
  assert.equal(r.reason, 'gateway_tls_untrusted');
  assert.match(r.hint, /--use-system-ca/);
  assert.match(r.hint, /HTTPS inspection|antivirus|firewall/i);

  // Direct code on the error (no cause) is also caught.
  const direct = classifyTransportFailure(Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' }));
  assert.equal(direct.reason, 'gateway_tls_untrusted');
});

test('classifyTransportFailure does NOT reframe genuine connect/DNS failures', () => {
  assert.equal(classifyTransportFailure(networkError('ECONNREFUSED')).reason, null);
  assert.equal(classifyTransportFailure(networkError('ENOTFOUND')).reason, null);
  assert.equal(classifyTransportFailure(networkError('UND_ERR_CONNECT_TIMEOUT')).reason, null);
  // causeChain still surfaces the real code for the diagnostic log.
  assert.equal(causeChain(networkError('ECONNREFUSED')).at(-1).code, 'ECONNREFUSED');
});

test('verify: HIGH-risk TLS-interception failure → BLOCK with gateway_tls_untrusted + hint', async () => {
  const client = new ShieldClient({
    apiUrl: 'http://x',
    apiKey: 'pv_live_x',
    sdk: throwingSdk(networkError('UNABLE_TO_VERIFY_LEAF_SIGNATURE')),
  });
  const r = await client.verify({ agentId: 'a', toolName: 'exec', input: 'rm -rf /tmp/x' });
  assert.equal(r.decision, 'BLOCK', 'fail-closed is preserved');
  assert.equal(r.reason, 'gateway_tls_untrusted', 'honest TLS reason, not the opaque generic one');
  assert.match(r.hint, /--use-system-ca/, 'actionable hint surfaced');
  assert.equal(r._fallback, true);
});

test('verify: HIGH-risk genuine connect failure → BLOCK keeps gateway_unavailable_failclosed (no hint)', async () => {
  const client = new ShieldClient({
    apiUrl: 'http://x',
    apiKey: 'pv_live_x',
    sdk: throwingSdk(networkError('ECONNREFUSED')),
  });
  const r = await client.verify({ agentId: 'a', toolName: 'exec', input: 'rm -rf /tmp/x' });
  assert.equal(r.decision, 'BLOCK');
  assert.equal(r.reason, 'gateway_unavailable_failclosed', 'real network errors keep the generic reason');
  assert.equal(r.hint, undefined, 'no TLS hint for a non-TLS failure');
});
