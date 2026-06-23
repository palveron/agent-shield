// test/debug-log.test.mjs
// The spawn-diagnostics facility must be (1) a true no-op when unset, (2) never
// throw, (3) secret-safe, (4) valid JSONL when enabled. These guard the
// "Correctness > Diagnosis" contract: the log can never affect governance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  isDebugEnabled,
  dlog,
  keyMeta,
  sanitizeProxyUrl,
  collectProxyEnv,
  causeChain,
  osEnvPresence,
  netSelftest,
} from '../src/debug-log.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// file:// URL so the subprocess `import()` works on Windows (drive paths aren't
// valid ESM specifiers).
const MODULE_URL = pathToFileURL(join(__dirname, '..', 'src', 'debug-log.mjs')).href;

// The test runner is launched WITHOUT AGENT_SHIELD_DEBUG_LOG_PATH.
test('no-op when AGENT_SHIELD_DEBUG_LOG_PATH is unset — disabled and never throws', () => {
  assert.equal(process.env.AGENT_SHIELD_DEBUG_LOG_PATH, undefined, 'precondition: env unset in runner');
  assert.equal(isDebugEnabled(), false);
  assert.doesNotThrow(() => dlog('should_be_dropped', { a: 1, secretish: 'pv_live_xxx' }));
});

test('keyMeta exposes only presence + length, never the value', () => {
  assert.deepEqual(keyMeta('pv_live_abcdef0123456789'), { present: true, len: 24 });
  assert.deepEqual(keyMeta(''), { present: false, len: 0 });
  assert.deepEqual(keyMeta(undefined), { present: false, len: 0 });
});

test('sanitizeProxyUrl strips embedded credentials and path, keeps host:port', () => {
  assert.equal(sanitizeProxyUrl('http://user:pass@proxy.corp:8080/path'), 'http://proxy.corp:8080');
  assert.equal(sanitizeProxyUrl('https://proxy.corp:3128'), 'https://proxy.corp:3128');
  // NO_PROXY-style host lists are not URLs → returned unchanged (no secret).
  assert.equal(sanitizeProxyUrl('localhost,127.0.0.1,.internal'), 'localhost,127.0.0.1,.internal');
});

test('collectProxyEnv only includes set vars and sanitizes proxy values', () => {
  const env = {
    HTTP_PROXY: 'http://user:secret@gw:8080',
    NO_PROXY: 'localhost,127.0.0.1',
    HTTPS_PROXY: '', // empty → excluded
  };
  const out = collectProxyEnv(env);
  assert.equal(out.HTTP_PROXY, 'http://gw:8080', 'credentials stripped');
  assert.equal(out.NO_PROXY, 'localhost,127.0.0.1');
  assert.equal('HTTPS_PROXY' in out, false, 'empty var excluded');
});

test('enabled: writes valid JSONL with ts/pid/monotonic-seq and no raw secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-shield-dlog-'));
  const logPath = join(dir, 'spawn.jsonl');
  try {
    // Module reads the env once at load → drive the enabled path in a subprocess.
    const script = `
      import('${MODULE_URL}').then((m) => {
        m.dlog('first', { keyMeta: m.keyMeta('pv_live_SUPERSECRETVALUE') });
        m.dlog('second', { n: 2 });
      });
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, AGENT_SHIELD_DEBUG_LOG_PATH: logPath },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `subprocess failed: ${r.stderr}`);

    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'one JSON object per dlog call');

    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    assert.equal(a.event, 'first');
    assert.equal(b.event, 'second');
    assert.equal(a.seq, 1, 'seq starts at 1');
    assert.equal(b.seq, 2, 'seq is monotonic per process');
    assert.equal(a.pid, b.pid, 'same pid within one process');
    assert.match(a.ts, /^\d{4}-\d{2}-\d{2}T.*Z$/, 'ISO ms timestamp');
    assert.deepEqual(a.keyMeta, { present: true, len: 24 });

    // Hard secret-hygiene assertion: the raw key value never appears anywhere.
    const raw = readFileSync(logPath, 'utf8');
    assert.equal(raw.includes('SUPERSECRETVALUE'), false, 'raw secret must never be logged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('causeChain unwraps the nested transport reason (the SDK masks it at the surface)', () => {
  // Mimic `TypeError: fetch failed` → cause: real undici/Node error.
  const inner = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), {
    code: 'ECONNREFUSED',
    errno: -4078,
    syscall: 'connect',
    address: '1.2.3.4',
    port: 443,
  });
  const top = new TypeError('fetch failed');
  top.cause = inner;

  const chain = causeChain(top);
  assert.equal(chain.length, 1, 'one cause level');
  assert.equal(chain[0].code, 'ECONNREFUSED');
  assert.equal(chain[0].syscall, 'connect');
  assert.equal(chain[0].address, '1.2.3.4');
  assert.equal(chain[0].port, 443);
});

test('causeChain follows AggregateError .errors and caps depth', () => {
  // undici connect failures surface sub-errors in `.errors`.
  const agg = new Error('all attempts failed');
  agg.errors = [Object.assign(new Error('getaddrinfo ENOTFOUND gw'), { code: 'ENOTFOUND', syscall: 'getaddrinfo' })];
  const top = new Error('fetch failed');
  top.cause = agg;
  const chain = causeChain(top);
  assert.equal(chain[0].message.includes('all attempts failed'), true);
  assert.equal(chain[1].code, 'ENOTFOUND', 'sub-error via .errors is surfaced');

  // Depth cap: a chain longer than 5 is truncated, never infinite.
  let head = new Error('L0');
  let node = head;
  for (let i = 1; i < 10; i++) {
    node.cause = new Error(`L${i}`);
    node = node.cause;
  }
  assert.equal(causeChain(head).length, 5, 'depth capped at 5');
  assert.deepEqual(causeChain({}), [], 'no cause → empty chain');
});

test('osEnvPresence reports presence only (never values) + PATH length', () => {
  const env = { SystemRoot: 'C:\\Windows', PATH: 'a;b;c' }; // WINDIR/TEMP/etc. absent
  const m = osEnvPresence(env);
  assert.equal(m.SystemRoot, true);
  assert.equal(m.WINDIR, false);
  assert.equal(m.TEMP, false);
  assert.deepEqual(m.PATH, { present: true, len: 5 });
  // Hard secret-hygiene: the actual SystemRoot path value must not leak.
  assert.equal(JSON.stringify(m).includes('Windows'), false, 'env values must never appear');
});

test('netSelftest is a no-op when diagnostics are disabled (no DNS, no fetch, no throw)', async () => {
  assert.equal(isDebugEnabled(), false, 'precondition: disabled in runner');
  // Resolves to undefined without touching the network or throwing. An IP that
  // would hang if probed proves it short-circuits before any fetch.
  await assert.doesNotReject(() => netSelftest('http://10.255.255.1:81'));
});

test('enabled but unwritable path → still never throws (Correctness > Diagnosis)', () => {
  // Deterministically unwritable on every platform: put the log "under" an
  // existing regular file, so both mkdir(parent) and append fail (ENOTDIR).
  const dir = mkdtempSync(join(tmpdir(), 'agent-shield-dlog-bad-'));
  const blocker = join(dir, 'iam-a-file');
  writeFileSync(blocker, 'x');
  const badPath = join(blocker, 'x.jsonl'); // a file used as a directory → ENOTDIR
  try {
    const script = `
      import('${MODULE_URL}').then((m) => {
        m.dlog('x', { a: 1 });        // must not throw despite an unwritable path
        process.stdout.write('SURVIVED');
      });
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, AGENT_SHIELD_DEBUG_LOG_PATH: badPath },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `subprocess crashed: ${r.stderr}`);
    assert.match(r.stdout, /SURVIVED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
