#!/usr/bin/env node
// bin/agent-shield.mjs
// CLI for agent-shield: init, status, test
// Usage:
//   npx agent-shield init     — Setup Shield (activate rules, register agent)
//   npx agent-shield status   — Show Shield status + 24h stats
//   npx agent-shield test     — Run a test governance check
//   npx agent-shield help     — Show usage

import { ShieldClient } from '../src/client.mjs';
import { updateOpenClawConfig } from '../src/openclaw-config.mjs';
import { hostname } from 'os';

// ─── Config Resolution ──────────────────────────────────────────────

function resolveConfig() {
  const apiUrl =
    process.env.PALVERON_API_URL ||
    process.env.AGENT_SHIELD_API_URL;
  const apiKey =
    process.env.PALVERON_API_KEY ||
    process.env.AGENT_SHIELD_API_KEY;

  // BYOM (Bring Your Own Model) keys are configured in the dashboard
  // (Settings → Neural Gateway) and used server-side. agent-shield does NOT
  // read or forward an LLM key.
  return { apiUrl, apiKey };
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
  });
}

// ─── Commands ────────────────────────────────────────────────────────

async function cmdInit() {
  const config = resolveConfig();
  const client = createClient(config);

  log('');
  log('🛡️  Palveron agent-shield — Setting up protection...');
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
  let activeTotal = 0;
  try {
    const result = await client.setupShield({
      hostname: hostname(),
    });
    // Report the REAL number of active protection rules — never a hardcoded
    // count. Prefer the gateway's truthful `policies_active` count (stable on
    // idempotent re-runs); fall back to the legacy created/activated sum for
    // older gateways that don't return it yet.
    activeTotal =
      result.policies_active ??
      ((result.policies_activated ?? 0) + (result.policies_created ?? 0));
    ok(`Shield activated: ${activeTotal} protection rule${activeTotal === 1 ? '' : 's'} active`);
    if (result.agent_name) {
      ok(`Agent "${result.agent_name}" registered`);
    }
    // Goal 2b — bind the REAL agent identity. `setupShield` already returns the
    // resolved agent_id (Goal 2a: ACTIVE + capabilityModel-seeded). Pass it to
    // the config writer so the MCP runtime sends it as metadata.agent_id and the
    // gateway ENFORCES capability instead of falling through to the unevaluated
    // 'default'. If the gateway omits agent_id, this stays undefined → no env key
    // → runtime keeps using 'default' (today's behaviour). Graceful.
    if (result.agent_id) {
      config.agentId = result.agent_id;
      ok(`Identity bound: agent ${result.agent_id}`);
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
    log(`    "args": ["-y", "-p", "@palveron/agent-shield", "agent-shield-mcp"],`);
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
  log(`  ${activeTotal} protection rule${activeTotal === 1 ? '' : 's'} now enforcing for this project.`);
  log('');
  log('  Run "agent-shield status" to see the active rules and 24h stats.');
  log('');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('');
}

async function cmdStatus() {
  const config = resolveConfig();
  const client = createClient(config);

  log('');
  log('🛡️  Palveron agent-shield — Status');
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
  log('🛡️  Palveron agent-shield — Test Run');
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

      // Never default a missing decision to ALLOW — a verdict-less response is
      // an anomaly, not a pass. Surface it as ERROR.
      const decision = result.decision || 'ERROR';
      if (decision === tc.expected) {
        ok(`${tc.name}: ${decision} ✓`);
      } else if (decision === 'ERROR') {
        warn(`${tc.name}: no decision returned (ERROR), expected ${tc.expected}`);
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
  log('🛡️  Palveron agent-shield — Control Layer for OpenClaw Agents');
  log('');
  log('Usage:');
  log('  npx agent-shield init     Set up Shield, activate rules, register agent');
  log('  npx agent-shield status   Show Shield status + 24h stats');
  log('  npx agent-shield test     Run test governance checks');
  log('  npx agent-shield help     Show this help');
  log('');
  log('Environment Variables:');
  log('  PALVERON_API_URL      Governance API URL');
  log('  PALVERON_API_KEY      Your project API key');
  log('');
  log('  AGENT_SHIELD_FAIL_CLOSED   Optional. "true" forces fail-closed (BLOCK) for');
  log('                             ALL risk levels if the gateway is unreachable.');
  log('                             Default: tiered (HIGH-risk fails closed,');
  log('                             MEDIUM/LOW fail open).');
  log('');
  log('  BYOM (Bring Your Own Model): configure your LLM key in the dashboard');
  log('  (Settings → Neural Gateway). It is used server-side — not via env here.');
  log('');
  log('See: https://docs.palveron.com/en/docs/integrations/openclaw');
  log('');
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
