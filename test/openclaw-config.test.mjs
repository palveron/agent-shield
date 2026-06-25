// test/openclaw-config.test.mjs
// F2: updateOpenClawConfig finds ~/.openclaw/openclaw.json (global default),
// writes the agent-shield MCP entry with the correct invocation, and preserves
// any pre-existing foreign mcpServers entries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateOpenClawConfig } from '../src/openclaw-config.mjs';

const EXPECTED_ARGS = ['-y', '-p', '@palveron/agent-shield', 'agent-shield-mcp'];

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'agent-shield-test-'));
}

test('writes agent-shield into ~/.openclaw/openclaw.json and preserves foreign entries', async () => {
  const home = await tmpRoot();
  const emptyCwd = await tmpRoot();
  try {
    const cfgPath = join(home, '.openclaw', 'openclaw.json');
    await mkdir(join(home, '.openclaw'), { recursive: true });
    await writeFile(
      cfgPath,
      JSON.stringify({ mcpServers: { 'some-other-server': { command: 'foo', args: ['bar'] } } }, null, 2),
    );

    const updated = await updateOpenClawConfig(
      { apiUrl: 'https://gateway.palveron.com', apiKey: 'pv_live_x' },
      { home, cwd: emptyCwd },
    );

    assert.equal(updated, true, 'should report it updated a file');
    const parsed = JSON.parse(await readFile(cfgPath, 'utf8'));

    // Foreign entry preserved.
    assert.deepEqual(parsed.mcpServers['some-other-server'], { command: 'foo', args: ['bar'] });

    // Our entry, with the correct (package-scoped) invocation.
    const entry = parsed.mcpServers['agent-shield'];
    assert.equal(entry.command, 'npx');
    assert.deepEqual(entry.args, EXPECTED_ARGS);
    assert.equal(entry.env.PALVERON_API_URL, 'https://gateway.palveron.com');
    assert.equal(entry.env.PALVERON_API_KEY, 'pv_live_x');
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(emptyCwd, { recursive: true, force: true });
  }
});

test('falls back to <cwd>/openclaw.json when no home config exists', async () => {
  const emptyHome = await tmpRoot();
  const cwd = await tmpRoot();
  try {
    const cfgPath = join(cwd, 'openclaw.json');
    await writeFile(cfgPath, JSON.stringify({}, null, 2));

    const updated = await updateOpenClawConfig({ apiUrl: 'u', apiKey: 'k' }, { home: emptyHome, cwd });
    assert.equal(updated, true);
    const parsed = JSON.parse(await readFile(cfgPath, 'utf8'));
    assert.deepEqual(parsed.mcpServers['agent-shield'].args, EXPECTED_ARGS);
  } finally {
    await rm(emptyHome, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test('returns false when no candidate config file exists', async () => {
  const emptyHome = await tmpRoot();
  const emptyCwd = await tmpRoot();
  try {
    const updated = await updateOpenClawConfig({ apiUrl: 'u', apiKey: 'k' }, { home: emptyHome, cwd: emptyCwd });
    assert.equal(updated, false);
  } finally {
    await rm(emptyHome, { recursive: true, force: true });
    await rm(emptyCwd, { recursive: true, force: true });
  }
});

// Goal 2b — identity binding: when init resolved an agent_id, it is written into
// the MCP env so the runtime sends the REAL identity (mcp-server.mjs:43).
test('writes AGENT_SHIELD_AGENT_ID into the env when config.agentId is set', async () => {
  const home = await tmpRoot();
  const emptyCwd = await tmpRoot();
  try {
    const cfgPath = join(home, '.openclaw', 'openclaw.json');
    await mkdir(join(home, '.openclaw'), { recursive: true });
    await writeFile(cfgPath, JSON.stringify({ mcpServers: { keepme: { command: 'foo' } } }, null, 2));

    const updated = await updateOpenClawConfig(
      { apiUrl: 'https://gw', apiKey: 'pv_live_x', agentId: 'agent_real_123' },
      { home, cwd: emptyCwd },
    );

    assert.equal(updated, true);
    const env = JSON.parse(await readFile(cfgPath, 'utf8')).mcpServers['agent-shield'].env;
    assert.equal(env.AGENT_SHIELD_AGENT_ID, 'agent_real_123', 'real id must be bound into the env');
    assert.equal(env.PALVERON_API_URL, 'https://gw');
    assert.equal(env.PALVERON_API_KEY, 'pv_live_x');
    // Foreign entry untouched.
    assert.deepEqual(
      JSON.parse(await readFile(cfgPath, 'utf8')).mcpServers.keepme,
      { command: 'foo' },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(emptyCwd, { recursive: true, force: true });
  }
});

// Without an agentId the env key must be ABSENT (not empty-string) so the MCP
// runtime falls back to 'default' exactly as before — graceful, inert.
test('omits AGENT_SHIELD_AGENT_ID entirely when config.agentId is unset', async () => {
  const home = await tmpRoot();
  const emptyCwd = await tmpRoot();
  try {
    const cfgPath = join(home, '.openclaw', 'openclaw.json');
    await mkdir(join(home, '.openclaw'), { recursive: true });
    await writeFile(cfgPath, JSON.stringify({}, null, 2));

    await updateOpenClawConfig({ apiUrl: 'u', apiKey: 'k' }, { home, cwd: emptyCwd });

    const env = JSON.parse(await readFile(cfgPath, 'utf8')).mcpServers['agent-shield'].env;
    assert.ok(!('AGENT_SHIELD_AGENT_ID' in env), 'env key must be absent, not empty-string');
    assert.equal(env.PALVERON_API_URL, 'u');
    assert.equal(env.PALVERON_API_KEY, 'k');
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(emptyCwd, { recursive: true, force: true });
  }
});
