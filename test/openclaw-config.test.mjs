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
