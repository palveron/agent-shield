// test/contract.test.mjs
// Proves the verify wire-contract end-to-end through the REAL @palveron/sdk:
// the body agent-shield sends must carry the fields the gateway requires
// (`prompt` top-level, `context.tool_name`, `metadata.agent_id`). A drift here
// was the launch-blocking bug (the gateway requires `prompt: String` and reads
// tool_name/agent_id from nested fields). We assert against the bytes actually
// put on the wire by the SDK, not a mock.
//
// Runs with the built-in Node test runner: `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ShieldClient } from '../src/client.mjs';

/** Spin a one-shot HTTP server that captures the first request body + replies. */
async function withCapturingServer(reply, run) {
  let captured = null;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      captured = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      };
      const { status, json } = reply(captured);
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const result = await run(`http://127.0.0.1:${port}`);
    return { captured, result };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('verify body matches the gateway contract: prompt top-level, context.tool_name, metadata.agent_id', async () => {
  const { captured, result } = await withCapturingServer(
    () => ({ status: 200, json: { decision: 'PASSED', trace_id: 't_ok', reason: 'clean' } }),
    async (baseUrl) => {
      const client = new ShieldClient({ apiUrl: baseUrl, apiKey: 'pv_test_x', maxRetries: 0 });
      return client.verify({ agentId: 'agent-7', toolName: 'exec', input: 'rm -rf /tmp/build' });
    },
  );

  // The bytes on the wire — the whole point of the SDK migration.
  assert.equal(captured.url, '/api/v1/verify');
  assert.equal(captured.body.prompt, 'rm -rf /tmp/build', 'prompt MUST be top-level');
  assert.equal(captured.body.context.tool_name, 'exec', 'tool_name MUST be nested under context');
  assert.equal(captured.body.metadata.agent_id, 'agent-7', 'agent_id MUST be in metadata');
  assert.equal(captured.body.metadata.source, 'agent-shield');
  assert.equal(captured.body.metadata.risk_level, 'HIGH');
  // SDK uses Bearer auth.
  assert.match(captured.headers.authorization ?? '', /^Bearer pv_test_x$/);

  // A clean PASSED is normalized to the agent-facing ALLOW.
  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.sdk_decision, 'PASSED');
  assert.equal(result._fallback, undefined, 'a real verdict must not look like a fallback');
});

test('a real BLOCKED verdict (HTTP 403 + body) surfaces as BLOCK, not an error or ALLOW', async () => {
  const { result } = await withCapturingServer(
    () => ({ status: 403, json: { decision: 'BLOCKED', reason: 'secret_exfiltration', trace_id: 't_blk' } }),
    async (baseUrl) => {
      const client = new ShieldClient({ apiUrl: baseUrl, apiKey: 'pv_test_x', maxRetries: 0 });
      return client.verify({ agentId: 'a', toolName: 'exec', input: 'echo AKIAIOSFODNN7EXAMPLE' });
    },
  );
  assert.equal(result.decision, 'BLOCK');
  assert.equal(result.sdk_decision, 'BLOCKED');
  assert.equal(result.reason, 'secret_exfiltration');
  assert.equal(result.trace_id, 't_blk');
  assert.equal(result._fallback, undefined);
});

test('a MODIFIED verdict surfaces as MODIFY with the sanitized output', async () => {
  const { result } = await withCapturingServer(
    () => ({ status: 200, json: { decision: 'MODIFIED', output: 'masked', reason: 'pii_masked' } }),
    async (baseUrl) => {
      const client = new ShieldClient({ apiUrl: baseUrl, apiKey: 'pv_test_x', maxRetries: 0 });
      return client.verify({ agentId: 'a', toolName: 'send_message', input: 'email me@x.com' });
    },
  );
  assert.equal(result.decision, 'MODIFY');
  assert.equal(result.modified_input, 'masked');
});
