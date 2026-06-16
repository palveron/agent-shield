// src/openclaw-config.mjs
// Locate and update the OpenClaw MCP config so `init` can wire agent-shield in
// automatically. Extracted from the CLI so the path resolution + merge behavior
// is unit-testable with injectable `home`/`cwd` (no global mocking).

import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Add (or update) the `agent-shield` MCP server entry in the user's OpenClaw
 * config. Writes only the first existing candidate file and preserves any
 * other `mcpServers` entries already present.
 *
 * Candidate order — the real OpenClaw global default first, then project-local:
 *   ~/.openclaw/openclaw.json   (OpenClaw default, global)
 *   <cwd>/openclaw.json
 *   <cwd>/.openclaw/config.json
 *
 * @param {{apiUrl?: string, apiKey?: string}} config
 * @param {{home?: string, cwd?: string}} [opts] - injectable for tests.
 * @returns {Promise<boolean>} true if a config file was found and updated.
 */
export async function updateOpenClawConfig(config, opts = {}) {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();

  const candidates = [
    join(home, '.openclaw', 'openclaw.json'),
    join(cwd, 'openclaw.json'),
    join(cwd, '.openclaw', 'config.json'),
  ];

  for (const configPath of candidates) {
    try {
      await access(configPath);
      const content = await readFile(configPath, 'utf8');
      const ocConfig = JSON.parse(content);

      // Preserve any existing mcpServers; only set our own entry.
      if (!ocConfig.mcpServers) {
        ocConfig.mcpServers = {};
      }

      ocConfig.mcpServers['agent-shield'] = {
        command: 'npx',
        // agent-shield-mcp is a bin INSIDE @palveron/agent-shield, not a
        // standalone package. `-p` points npx at the right package so the
        // invocation resolves whether or not the package is installed globally.
        args: ['-y', '-p', '@palveron/agent-shield', 'agent-shield-mcp'],
        env: {
          PALVERON_API_URL: config.apiUrl || '',
          PALVERON_API_KEY: config.apiKey || '',
        },
      };

      await writeFile(configPath, JSON.stringify(ocConfig, null, 2) + '\n');
      return true;
    } catch {
      // File doesn't exist or can't be read — try the next candidate.
      continue;
    }
  }

  return false;
}
