// test/mcp-server.test.mjs
// Drives the real MCP server over stdio against a mock gateway.
// F1: governance_check with a missing field → decision ERROR (never ALLOW).
// F4: a previously "low-risk" tool now goes through verify (hits the gateway,
//     gets a real decision) — there is no local skip that returns ALLOW.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'agent-shield-mcp.mjs');

/** Mock gateway that records /verify calls and always returns PASSED. */
function startMockGateway() {
  const verifyCalls = [];
  const server = createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      if (req.url === '/api/v1/verify') {
        verifyCalls.push(buf ? JSON.parse(buf) : null);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ decision: 'PASSED', reason: 'clean', trace_id: 't1' }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return { server, verifyCalls };
}

/** Spawn the MCP server, send framed requests, collect framed responses by id. */
function driveMcp(baseUrl, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, PALVERON_API_URL: baseUrl, PALVERON_API_KEY: 'pv_live_x' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const responses = {};
    child.stdout.on('data', (d) => {
      out += d.toString();
      // Parse all complete Content-Length frames currently buffered.
      while (true) {
        const m = out.match(/Content-Length:\s*(\d+)\r\n\r\n/i);
        if (!m) break;
        const headerEnd = m.index + m[0].length;
        const len = parseInt(m[1], 10);
        if (out.length < headerEnd + len) break;
        const body = out.slice(headerEnd, headerEnd + len);
        out = out.slice(headerEnd + len);
        try {
          const msg = JSON.parse(body);
          if (msg.id !== undefined) responses[msg.id] = msg;
        } catch {
          /* ignore */
        }
      }
    });
    child.on('error', reject);

    for (const r of requests) {
      const body = JSON.stringify(r);
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }

    setTimeout(() => {
      child.kill();
      resolve(responses);
    }, 1000);
  });
}

/** Pull the decision JSON out of an MCP tools/call result. */
function decisionOf(resp) {
  return JSON.parse(resp.result.content[0].text);
}

test('F1: governance_check missing input → ERROR (never ALLOW); F4: real tools hit verify', async () => {
  const { server, verifyCalls } = startMockGateway();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const responses = await driveMcp(baseUrl, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      // missing input
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'governance_check', arguments: { tool_name: 'exec' } } },
      // missing tool_name
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'governance_check', arguments: { input: 'rm -rf /' } } },
      // a previously "low-risk" tool — must still go through verify (no skip)
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'governance_check', arguments: { tool_name: 'list_directory', input: 'ls /' } } },
    ]);

    const d2 = decisionOf(responses[2]);
    assert.equal(d2.decision, 'ERROR', 'missing input must be ERROR, never ALLOW');
    assert.equal(d2.reason, 'missing_required_field');

    const d3 = decisionOf(responses[3]);
    assert.equal(d3.decision, 'ERROR', 'missing tool_name must be ERROR, never ALLOW');

    const d4 = decisionOf(responses[4]);
    assert.equal(d4.decision, 'ALLOW', 'list_directory resolves to the gateway PASSED verdict');
    assert.notEqual(d4.reason, 'low_risk_tool', 'there must be no local skip path');
    assert.equal(verifyCalls.length, 1, 'the "low-risk" tool must have hit /verify (no skip)');
    // Goal 2b — the wire tool_name is normalized: list_directory → files:read.
    assert.equal(verifyCalls[0].context.tool_name, 'files:read');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
