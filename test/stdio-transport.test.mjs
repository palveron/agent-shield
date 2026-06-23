// test/stdio-transport.test.mjs
// Pure transport-level coverage for the JSON-RPC stdio framing fix:
//   - NDJSON (MCP standard) is the default framing.
//   - Content-Length (legacy LSP-style) is tolerated.
//   - Responses MIRROR the detected input framing.
//   - Malformed JSON never crashes the read loop.
//   - Messages split across chunks are delivered only once complete.
//
// We drive the REAL message handlers by wiring the transport to a tiny in-test
// harness that mirrors src/mcp-server.mjs's dispatch (initialize / tools/list /
// notifications/initialized). No process, no stdin — strings in, writes out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStdioTransport } from '../src/stdio-transport.mjs';

const PROTOCOL_VERSION = '2024-11-05';

/**
 * Build a transport whose onMessage applies the same dispatch shape the MCP
 * server uses for the methods under test. Returns the transport plus the array
 * of raw output chunks written by the transport.
 */
function harness() {
  const writes = [];
  const transport = createStdioTransport({
    onMessage: (msg) => {
      const { id, method } = msg;
      switch (method) {
        case 'initialize':
          transport.send({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'palveron-governance', version: '0.1.0' },
            },
          });
          break;
        case 'notifications/initialized':
          break; // notification → no response
        case 'tools/list':
          transport.send({
            jsonrpc: '2.0',
            id,
            result: { tools: [{ name: 'governance_check' }] },
          });
          break;
        default:
          if (id !== undefined) {
            transport.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
          }
      }
    },
    write: (s) => writes.push(s),
    onParseError: () => writes.push('__PARSE_ERROR__'),
  });
  return { transport, writes };
}

function ndjson(obj) {
  return JSON.stringify(obj) + '\n';
}

function contentLength(obj) {
  const json = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

/** Parse a single NDJSON output chunk (must end with exactly one newline). */
function parseNdjson(chunk) {
  assert.ok(chunk.endsWith('\n'), 'NDJSON response must end with a newline');
  assert.equal(chunk.indexOf('\n'), chunk.length - 1, 'exactly one line per NDJSON response');
  return JSON.parse(chunk.slice(0, -1));
}

/** Parse a single Content-Length output chunk. */
function parseContentLength(chunk) {
  const m = chunk.match(/^Content-Length:\s*(\d+)\r\n\r\n/i);
  assert.ok(m, 'response must carry a Content-Length header');
  const body = chunk.slice(m[0].length);
  assert.equal(Buffer.byteLength(body), parseInt(m[1], 10), 'Content-Length must match body byte length');
  return JSON.parse(body);
}

test('NDJSON initialize → one NDJSON response line with serverInfo + protocolVersion', () => {
  const { transport, writes } = harness();
  transport.push(
    ndjson({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'probe', version: '0' } },
    }),
  );

  assert.equal(transport.framing, 'ndjson');
  assert.equal(writes.length, 1, 'exactly one response');
  const resp = parseNdjson(writes[0]);
  assert.equal(resp.id, 1);
  assert.equal(resp.result.serverInfo.name, 'palveron-governance');
  assert.equal(resp.result.protocolVersion, PROTOCOL_VERSION);
});

test('NDJSON tools/list → response lists governance_check', () => {
  const { transport, writes } = harness();
  transport.push(ndjson({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));

  assert.equal(writes.length, 1);
  const resp = parseNdjson(writes[0]);
  assert.deepEqual(
    resp.result.tools.map((t) => t.name),
    ['governance_check'],
  );
});

test('Content-Length initialize → correct response, mirrored in Content-Length framing', () => {
  const { transport, writes } = harness();
  transport.push(
    contentLength({
      jsonrpc: '2.0',
      id: 7,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'probe', version: '0' } },
    }),
  );

  assert.equal(transport.framing, 'content-length');
  assert.equal(writes.length, 1);
  const resp = parseContentLength(writes[0]);
  assert.equal(resp.id, 7);
  assert.equal(resp.result.serverInfo.name, 'palveron-governance');
});

test('notifications/initialized (no id) → no response', () => {
  const { transport, writes } = harness();
  transport.push(ndjson({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(writes.length, 0, 'a notification must never get a response');
});

test('chunk-splitting: a message split across two push() calls is delivered once complete', () => {
  const { transport, writes } = harness();
  const line = ndjson({ jsonrpc: '2.0', id: 9, method: 'initialize', params: {} });
  const half = Math.floor(line.length / 2);

  transport.push(line.slice(0, half)); // partial line — nothing yet
  assert.equal(writes.length, 0, 'no delivery until the newline arrives');

  transport.push(line.slice(half)); // completes the line
  assert.equal(writes.length, 1, 'delivered exactly once when complete');
  assert.equal(parseNdjson(writes[0]).id, 9);
});

test('malformed JSON does not crash the loop and a following valid message still works', () => {
  const { transport, writes } = harness();
  transport.push('{ this is not json }\n');
  assert.deepEqual(writes, ['__PARSE_ERROR__'], 'parse error reported, loop alive');

  transport.push(ndjson({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }));
  assert.equal(writes.length, 2, 'the next valid message is still processed');
  assert.equal(parseNdjson(writes[1]).result.tools[0].name, 'governance_check');
});
