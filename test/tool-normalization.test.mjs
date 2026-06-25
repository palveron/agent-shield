// test/tool-normalization.test.mjs
// Goal 2b — the native→capability map (BEFUND Strang B). Proves the dogfood-
// critical tools land on the right gateway key (and therefore the right
// enforcement mode under the Goal-1 preset), case/separator variants collapse,
// and unknown tools stay key-without-':' (gateway external → REQUIRE_APPROVAL).
//
// Runs with the built-in Node test runner: `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToolName } from '../src/tool-normalization.mjs';

test('maps the dogfood-critical + representative tools to their capability keys', () => {
  // communication → ALLOW
  assert.equal(normalizeToolName('send_email'), 'email:send');
  assert.equal(normalizeToolName('send_message'), 'slack:send');
  // external read via api:get override → ALLOW (web_search keeps the unattended run alive)
  assert.equal(normalizeToolName('web_search'), 'api:get');
  assert.equal(normalizeToolName('fetch_url'), 'api:get');
  assert.equal(normalizeToolName('git_status'), 'api:get');
  // external write → REQUIRE_APPROVAL
  assert.equal(normalizeToolName('http_request'), 'api:post');
  assert.equal(normalizeToolName('git_push'), 'api:post');
  // infrastructure → DENY
  assert.equal(normalizeToolName('exec'), 'infra:code_exec');
  assert.equal(normalizeToolName('install_package'), 'infra:code_exec');
  // data
  assert.equal(normalizeToolName('read_file'), 'files:read');
  assert.equal(normalizeToolName('write_file'), 'files:write');
  assert.equal(normalizeToolName('delete_file'), 'files:delete');
  assert.equal(normalizeToolName('sql_query'), 'db:query');
  assert.equal(normalizeToolName('drop_table'), 'db:mutate');
  // payments
  assert.equal(normalizeToolName('payment'), 'payment:execute');
});

test('collapses case + separator variants to one key (same as classifyRisk)', () => {
  assert.equal(normalizeToolName('send-email'), 'email:send');
  assert.equal(normalizeToolName('Send Email'), 'email:send');
  assert.equal(normalizeToolName('SEND_EMAIL'), 'email:send');
  assert.equal(normalizeToolName('Web Search'), 'api:get');
});

test('unknown tool → normalized key WITHOUT a ":" (gateway external → REQUIRE_APPROVAL)', () => {
  const out = normalizeToolName('foobar_tool');
  assert.equal(out, 'foobar_tool');
  assert.ok(!out.includes(':'), 'unknown tool must not synthesize a capability prefix');
  // separator-normalized but still unmapped
  assert.equal(normalizeToolName('Some New Tool'), 'some_new_tool');
});

test('falsy input is passed through unchanged (no throw)', () => {
  assert.equal(normalizeToolName(''), '');
  assert.equal(normalizeToolName(undefined), undefined);
  assert.equal(normalizeToolName(null), null);
});
