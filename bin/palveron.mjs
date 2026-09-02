#!/usr/bin/env node
// bin/palveron.mjs
// The ONE entry point of @palveron/agent-shield: `palveron shield <subcommand>`.
// Replaces the two pre-release entry points (the old CLI bin and the old
// standalone MCP bin) — merged before first publish, so there is deliberately
// NO alias and NO compatibility layer for the old names.
//
// Usage:
//   palveron shield init     — Setup Shield (activate rules, register agent)
//   palveron shield status   — Show Shield status + 24h stats
//   palveron shield test     — Run a test governance check
//   palveron shield mcp      — Start the governance MCP server (stdio)
//   palveron help            — Show usage (same as bare `palveron`)
//
// `shield mcp` is what openclaw.json spawns:
//   "command": "npx",
//   "args": ["-y", "-p", "@palveron/agent-shield", "palveron", "shield", "mcp"]
// On that path stdout is the JSON-RPC channel — nothing below may print to
// stdout before the MCP server owns it (diagnostics go to the dlog file).

import { ShieldClient } from '../src/client.mjs';
import { updateOpenClawConfig } from '../src/openclaw-config.mjs';
import { startMcpServer } from '../src/mcp-server.mjs';
import {
  dlog,
  keyMeta,
  collectProxyEnv,
  osEnvPresence,
  tlsEnvSnapshot,
  dnsServersSafe,
  netSelftest,
} from '../src/debug-log.mjs';
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
    log(`    "args": ["-y", "-p", "@palveron/agent-shield", "palveron", "shield", "mcp"],`);
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
  log('  Run "palveron shield status" to see the active rules and 24h stats.');
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
      warn('Shield is NOT active — run "palveron shield init" to activate');
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
  log('🛡️  Palveron — Control Layer for OpenClaw Agents');
  log('');
  log('Usage:');
  log('  palveron shield init     Set up Shield, activate rules, register agent');
  log('  palveron shield status   Show Shield status + 24h stats');
  log('  palveron shield test     Run test governance checks');
  log('  palveron shield mcp      Start the governance MCP server (stdio)');
  log('  palveron help            Show this help');
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

// ─── MCP server (`palveron shield mcp`) ──────────────────────────────
// Formerly a standalone MCP bin. stdout belongs to the JSON-RPC transport
// from here on — diagnostics only via dlog/stderr.

function runMcp() {
  // proc_start — emitted as early as possible so the log captures exactly what
  // the SPAWNED process sees (vs. what `openclaw mcp show` claims). Decides H2
  // (inherited proxy/NODE_OPTIONS), H3 (env divergence), H4 (cwd), plus the
  // spawn NETWORK context (DNS resolvers, TLS env, undici version, whether
  // OpenClaw stripped the OS env). Reads the same env aliases the client reads
  // (mcp-server.mjs: PALVERON_* preferred, AGENT_SHIELD_* fallback).
  // Secret-safe: key only as presence + length; OS-env values are NEVER logged
  // (presence only); CA cert as path only.
  const apiUrl = process.env.PALVERON_API_URL || process.env.AGENT_SHIELD_API_URL || null;
  const apiKey = process.env.PALVERON_API_KEY || process.env.AGENT_SHIELD_API_KEY || '';
  const km = keyMeta(apiKey);
  dlog('proc_start', {
    cwd: process.cwd(),
    argv: process.argv,
    execPath: process.execPath,
    nodeVersion: process.version,
    versions: {
      node: process.versions.node,
      undici: process.versions.undici ?? null,
      openssl: process.versions.openssl ?? null,
    },
    apiUrl,
    apiUrlEnvSeen: {
      PALVERON_API_URL: process.env.PALVERON_API_URL ?? null,
      AGENT_SHIELD_API_URL: process.env.AGENT_SHIELD_API_URL ?? null,
    },
    apiKeyPresent: km.present,
    apiKeyLen: km.len,
    agentId: process.env.AGENT_SHIELD_AGENT_ID ?? null, // not a secret
    proxyEnv: collectProxyEnv(),
    tlsEnv: tlsEnvSnapshot(),
    dnsServers: dnsServersSafe(),
    osEnv: osEnvPresence(),
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    failClosedOverride: process.env.AGENT_SHIELD_FAIL_CLOSED ?? null,
  });

  // Active connectivity self-test — no-op unless diagnostics are enabled. Runs
  // the RAW fetch outside the SDK so the un-masked undici cause chain is
  // captured. Fire-and-forget: a pending fetch keeps the event loop alive long
  // enough for the events to be written even on the short-lived direct-control
  // run; never throws.
  netSelftest(apiUrl).catch(() => {});

  startMcpServer().catch((err) => {
    dlog('proc_fatal', { errName: err?.name, errMessage: String(err?.message ?? err).slice(0, 300) });
    process.stderr.write(`[palveron shield mcp] Fatal: ${err.message}\n`);
    process.exit(1);
  });
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

const group = process.argv[2];
const sub = process.argv[3];

if (group === undefined || group === 'help' || group === '--help' || group === '-h') {
  cmdHelp();
} else if (group === 'shield') {
  switch (sub) {
    case 'mcp':
      runMcp();
      break;
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
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      cmdHelp();
      break;
    default:
      error(`Unknown shield command: ${sub}`);
      cmdHelp();
      process.exit(1);
  }
} else {
  error(`Unknown command: ${group}`);
  cmdHelp();
  process.exit(1);
}
