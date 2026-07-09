// B1e — agent-shield tolerates BOTH gateway error-body shapes.
//
// The gateway error contract moved from a flat `{ error: "<msg>" }` string to a
// structured `{ error: { code, message, request_id } }` object. The Shield's own
// error-body read (`client.mjs`) must surface a real string detail either way —
// never `[object Object]`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShieldErrorDetail } from '../src/client.mjs';

test('NEW structured object-shape → error.message', () => {
  const detail = parseShieldErrorDetail(
    JSON.stringify({ error: { code: 'validation_error', message: 'Prompt is required', request_id: 'r1' } }),
  );
  assert.equal(detail, 'Prompt is required');
});

test('LEGACY flat-string error → the string', () => {
  const detail = parseShieldErrorDetail(JSON.stringify({ error: 'Old flat message' }));
  assert.equal(detail, 'Old flat message');
});

test('BLOCKED verdict body → reason', () => {
  const detail = parseShieldErrorDetail(JSON.stringify({ reason: 'Denied by capability model', decision: 'BLOCKED' }));
  assert.equal(detail, 'Denied by capability model');
});

test('object-shape result is ALWAYS a string, never [object Object]', () => {
  const detail = parseShieldErrorDetail(JSON.stringify({ error: { code: 'forbidden', message: 'Nope' } }));
  assert.equal(typeof detail, 'string');
  assert.notEqual(detail, '[object Object]');
});

test('non-JSON body → raw text passthrough', () => {
  assert.equal(parseShieldErrorDetail('plain text 502'), 'plain text 502');
  assert.equal(parseShieldErrorDetail(''), '');
});

test('object error without a usable message → raw text fallback', () => {
  const raw = JSON.stringify({ error: { code: 123 } });
  assert.equal(parseShieldErrorDetail(raw), raw);
});
