#!/usr/bin/env node
// bin/agent-shield.mjs
// CLI for agent-shield: init, status, test
// Usage:
//   npx agent-shield init     — Setup Shield (8 rules, register agent)
//   npx agent-shield status   — Show Shield status + 24h stats
//   npx agent-shield test     — Run a test governance check
//   npx agent-shield help     — Show usage

import { ShieldClient } from '../src/client.mjs';
import { readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';
import { hostname } from 'os';

// ─── Config Resolution ──────────────────────────────────────────────

function resolveConfig() {
  const apiUrl =
    process.env.PALVERON_API_URL ||
    process.env.AGENT_SHIELD_API_URL;
  const apiKey =
    process.env.PALVERON_API_KEY ||
    process.env.AGENT_SHIELD_API_KEY;
  const llmApiKey =
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.LLM_API_KEY;

  return { apiUrl, apiKey, llmApiKey };
}

function createClient(config) {
  if (!config.apiUrl) {
    error('Missing PALVERON_API_URL (or AGENT_SHIELD_API_URL) environment variable');
    hint('Get your API URL from your dashboard settings');
    process.exit(1);
  }
  if (!config.apiKey) {
    error('Missing PALVERON_API_KEY (or AGENT_SHIELD_API_KEY) environment variable');
    hint('Get your API key from your dashboard → Settings → API Keys');
    process.exit(1);
  }
  return new ShieldClient({
    apiUrl: config.apiUrl,
    apiKey: config.apiKey,
    llmApiKey: config.llmApiKey,
  });
}

// ─── Commands ────────────────────────────────────────────────────────

async function cmdInit() {
  const config = resolveConfig();
  const client = createClient(config);

  log('');
  log('🛡️  agent-shield — Setting up protection...');
  log('');

  // 1. Validate API key
  step('Validating API key...');
  try {
    const health = await client.health();
    ok(`API connected (${health.version || 'ok'})`);
  } catch (err) {
    fail('Cannot reach governance API');
    error(err.message);
    hint('Check PALVERON_API_URL and ensure the server is running');
    process.exit(1);
  }

  // 2. Setup Shield
  step('Activating Shield protection rules...');
  try {
    const result = await client.setupShield({
      hostname: hostname(),
    });
    ok(`Shield activated: ${result.policies_activated + result.policies_created} protection rules`);
    if (result.agent_name) {
      ok(`Agent "${result.agent_name}" registered`);
    }
  } catch (err) {
    fail('Shield setup failed');
    error(err.message);
    process.exit(1);
  }

  // 3. Update openclaw.json if it exists
  step('Configuring OpenClaw MCP integration...');
  const updated = await updateOpenClawConfig(config);
  if (updated) {
    ok('openclaw.json updated (MCP Server mode)');
  } else {
    warn('openclaw.json not found — manual MCP configuration needed');
    hint('Add this to your openclaw.json mcpServers section:');
    log('');
    log(`  "agent-shield": {`);
    log(`    "command": "npx",`);
    log(`    "args": ["-y", "agent-shield-mcp"],`);
    log(`    "env": {`);
    log(`      "PALVERON_API_URL": "${config.apiUrl || 'YOUR_API_URL'}",`);
    log(`      "PALVERON_API_KEY": "${maskKey(config.apiKey)}"`);
    log(`    }`);
    log(`  }`);
  }

  // 4. Blockchain info
  log('');
  ok('Blockchain: Set up your Flare wallet for on-chain proof');
  hint('Without wallet: local SHA-256 hashes (tamper-detectable)');
  hint('Guide: See your dashboard → Settings → Blockchain');

  // 5. Summary
  log('');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('');
  log('  ✅ Shield is active. Your agent is protected.');
  log('');
  log('  8 protection rules are now enforcing:');
  log('  • Secret-Exfiltration-Shield  → BLOCK leaked keys');
  log('  • Shell-Injection-Guard       → BLOCK dangerous commands');
  log('  • Destructive-Actions-Shield  → BLOCK rm -rf, DROP TABLE');
  log('  • Package-Install-Watchdog    → APPROVAL for installs');
  log('  • Social-Media-Output-Guard   → ANONYMIZE PII in posts');
  log('  • GDPR Privacy Shield         → ANONYMIZE personal data');
  log('  • Circuit Breaker             → BLOCK agent loops');
  log('  • Fiscal Authority Limit      → APPROVAL for >€1,000');
  log('');
  log('  Run "agent-shield status" to see 24h protection stats.');
  log('');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('');
}

async function cmdStatus() {
  const config = resolveConfig();
  const client = createClient(config);

  log('');
  log('🛡️  agent-shield — Status');
  log('');

  try {
    const status = await client.getShieldStatus();

    if (status.shield_active) {
      ok('Shield is ACTIVE');
    } else {
      warn('Shield is NOT active — run "agent-shield init" to activate');
    }

    log('');
    log(`  Agents registered:   ${status.agent_count}`);
    log(`  Active policies:     ${status.policies?.length || 0}`);
    log('');
    log('  Last 24 hours:');
    log(`    Total traces:      ${status.total_traces_24h}`);
    log(`    Blocked:           ${status.blocked_24h}`);
    log(`    Anonymized:        ${status.anonymized_24h}`);
    log('');

    if (status.policies?.length > 0) {
      log('  Active policies:');
      for (const p of status.policies) {
        const badge = p.source === 'OPENCLAW_SHIELD' ? '🛡️' : '📋';
        log(`    ${badge} ${p.name} → ${p.action}`);
      }
      log('');
    }
  } catch (err) {
    fail('Cannot fetch Shield status');
    error(err.message);
    process.exit(1);
  }
}

async function cmdTest() {
  const config = resolveConfig();
  const client = createClient(config);

  log('');
  log('🛡️  agent-shield — Test Run');
  log('');

  const testCases = [
    {
      name: 'Safe read',
      tool: 'read_file',
      input: 'Read config.json',
      expected: 'ALLOW',
    },
    {
      name: 'Dangerous command',
      tool: 'exec',
      input: 'rm -rf /',
      expected: 'BLOCK',
    },
    {
      name: 'Secret in output',
      tool: 'exec',
      input: 'echo "my key is sk-1234567890abcdef1234567890abcdef"',
      expected: 'BLOCK',
    },
  ];

  for (const tc of testCases) {
    step(`Testing: ${tc.name}...`);
    try {
      const result = await client.verify({
        agentId: 'test-agent',
        toolName: tc.tool,
        input: tc.input,
      });

      const decision = result.decision || 'ALLOW';
      if (decision === tc.expected) {
        ok(`${tc.name}: ${decision} ✓`);
      } else {
        warn(`${tc.name}: got ${decision}, expected ${tc.expected}`);
      }
    } catch (err) {
      fail(`${tc.name}: ${err.message}`);
    }
  }

  log('');
  log('Test complete.');
  log('');
}

function cmdHelp() {
  log('');
  log('🛡️  agent-shield — Control Layer for OpenClaw Agents');
  log('');
  log('Usage:');
  log('  npx agent-shield init     Set up Shield (8 rules, register agent)');
  log('  npx agent-shield status   Show Shield status + 24h stats');
  log('  npx agent-shield test     Run test governance checks');
  log('  npx agent-shield help     Show this help');
  log('');
  log('Environment Variables:');
  log('  PALVERON_API_URL      Governance API URL');
  log('  PALVERON_API_KEY      Your project API key');
  log('  OPENAI_API_KEY     Your LLM key (for BYOM 2-pass analysis)');
  log('');
  log('See: https://palveron.com/docs/openclaw');
  log('');
}

// ─── OpenClaw Config Update ──────────────────────────────────────────

async function updateOpenClawConfig(config) {
  // Look for openclaw.json in current directory and common locations
  const candidates = [
    join(process.cwd(), 'openclaw.json'),
    join(process.cwd(), '.openclaw', 'config.json'),
  ];

  for (const configPath of candidates) {
    try {
      await access(configPath);
      const content = await readFile(configPath, 'utf8');
      const ocConfig = JSON.parse(content);

      // Add or update MCP server entry
      if (!ocConfig.mcpServers) {
        ocConfig.mcpServers = {};
      }

      ocConfig.mcpServers['agent-shield'] = {
        command: 'npx',
        args: ['-y', 'agent-shield-mcp'],
        env: {
          PALVERON_API_URL: config.apiUrl || '',
          PALVERON_API_KEY: config.apiKey || '',
        },
      };

      await writeFile(configPath, JSON.stringify(ocConfig, null, 2) + '\n');
      return true;
    } catch {
      // File doesn't exist or can't be read — try next
      continue;
    }
  }

  return false;
}

// ─── Output Helpers ──────────────────────────────────────────────────

function log(msg) { console.log(msg); }
function step(msg) { console.log(`  ⏳ ${msg}`); }
function ok(msg) { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.log(`  ⚠️  ${msg}`); }
function fail(msg) { console.log(`  ❌ ${msg}`); }
function error(msg) { console.error(`  Error: ${msg}`); }
function hint(msg) { console.log(`     → ${msg}`); }

function maskKey(key) {
  if (!key) return 'YOUR_API_KEY';
  if (key.length <= 8) return '***';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

// ─── Main ────────────────────────────────────────────────────────────

const command = process.argv[2] || 'help';

switch (command) {
  case 'init':
    cmdInit().catch((err) => {
      error(err.message);
      process.exit(1);
    });
    break;
  case 'status':
    cmdStatus().catch((err) => {
      error(err.message);
      process.exit(1);
    });
    break;
  case 'test':
    cmdTest().catch((err) => {
      error(err.message);
      process.exit(1);
    });
    break;
  case 'help':
  case '--help':
  case '-h':
    cmdHelp();
    break;
  default:
    error(`Unknown command: ${command}`);
    cmdHelp();
    process.exit(1);
}
