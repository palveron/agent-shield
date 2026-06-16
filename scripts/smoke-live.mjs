#!/usr/bin/env node
// scripts/smoke-live.mjs
// Live end-to-end smoke for agent-shield against a real Palveron Gateway.
// NOT shipped in the npm package (not listed in package.json "files").
//
// SAFETY: refuses to run unless PALVERON_API_KEY starts with "pv_test_".
// `init` (setupShield) writes policies + an agent into the project, so this
// must only ever run against a TEST project — never the production core key.
//
// Usage (PowerShell):
//   $env:PALVERON_API_KEY="pv_test_xxx"
//   $env:PALVERON_API_URL="https://gateway.palveron.com"   # optional, this is the default
//   node scripts/smoke-live.mjs
//
// Usage (bash):
//   PALVERON_API_KEY=pv_test_xxx node scripts/smoke-live.mjs
//
// Exit code 0 = all hard expectations met. Non-zero = a hard check failed.

import { hostname } from 'node:os';
import { ShieldClient } from '../src/client.mjs';

const API_URL = process.env.PALVERON_API_URL || process.env.AGENT_SHIELD_API_URL || 'https://gateway.palveron.com';
const API_KEY = process.env.PALVERON_API_KEY || process.env.AGENT_SHIELD_API_KEY || '';

let hardFailures = 0;
const line = (s = '') => console.log(s);
const pass = (s) => line(`  ✅ ${s}`);
const warn = (s) => line(`  ⚠️  ${s}`);
const fail = (s) => { line(`  ❌ ${s}`); hardFailures++; };

function check(name, ok, detail, { hard = true } = {}) {
  const msg = `${name}${detail ? ` — ${detail}` : ''}`;
  if (ok) pass(msg);
  else if (hard) fail(msg);
  else warn(`${msg} (soft — verify against your project's policies)`);
}

// ── Guards ───────────────────────────────────────────────────────────
if (!API_KEY) {
  console.error('Missing PALVERON_API_KEY. Set a TEST project key (pv_test_…).');
  process.exit(2);
}
if (!API_KEY.startsWith('pv_test_')) {
  console.error(
    'Refusing to run: PALVERON_API_KEY must start with "pv_test_". ' +
      'This smoke calls init (writes policies + an agent), so it must target a TEST project, never production.',
  );
  process.exit(2);
}

line('');
line(`🛡️  agent-shield live smoke → ${API_URL}`);
line('');

const client = new ShieldClient({ apiUrl: API_URL, apiKey: API_KEY, maxRetries: 1 });

// A client pointed at an unreachable address, to exercise the fail policy.
const downClient = new ShieldClient({ apiUrl: 'http://127.0.0.1:9', apiKey: API_KEY, maxRetries: 0, timeout: 800 });

// A client with a deliberately invalid key, to prove fail-LOUD (no silent ALLOW).
const badKeyClient = new ShieldClient({ apiUrl: API_URL, apiKey: 'pv_test_definitely_invalid_key', maxRetries: 0 });

try {
  // 1. Health preflight (proves the /health path, B2) ──────────────────
  line('1) Health preflight (GET /health)');
  try {
    const h = await client.health();
    check('health reachable', !!h && (h.status === 'healthy' || !!h.version), `status=${h?.status} version=${h?.version}`);
  } catch (e) {
    fail(`health threw: ${e?.message}`);
  }
  line('');

  // 2. Benign HIGH-risk action → real decision (expect ALLOW/PASSED) ────
  line('2) Benign action (exec "echo hello") → expect ALLOW');
  {
    const r = await client.verify({ agentId: 'smoke', toolName: 'exec', input: 'echo hello world' });
    check('benign allowed', r.decision === 'ALLOW', `decision=${r.decision} sdk=${r.sdk_decision} reason=${r.reason}`);
    check('not a fallback', r._fallback === undefined, 'real verdict, not a fail fallback');
  }
  line('');

  // 3. Destructive action → expect BLOCK ───────────────────────────────
  line('3) Destructive action (exec "rm -rf /") → expect BLOCK');
  {
    const r = await client.verify({ agentId: 'smoke', toolName: 'exec', input: 'rm -rf /' });
    check('destructive blocked', r.decision === 'BLOCK', `decision=${r.decision} sdk=${r.sdk_decision} reason=${r.reason}`);
  }
  line('');

  // 4. Secret in payload → expect BLOCK (soft: depends on policy scope) ─
  line('4) Fake AWS key (AKIA…) → expect BLOCK');
  {
    const r = await client.verify({ agentId: 'smoke', toolName: 'exec', input: 'echo AKIAIOSFODNN7EXAMPLE' });
    check('secret blocked', r.decision === 'BLOCK', `decision=${r.decision} sdk=${r.sdk_decision} reason=${r.reason}`, { hard: false });
  }
  line('');

  // 5. Simulated outage, HIGH-risk → fail-CLOSED BLOCK ─────────────────
  line('5) Gateway unreachable + HIGH-risk (exec) → expect BLOCK (fail-closed)');
  {
    const r = await downClient.verify({ agentId: 'smoke', toolName: 'exec', input: 'rm -rf /' });
    check('high-risk fails closed', r.decision === 'BLOCK' && r.reason === 'gateway_unavailable_failclosed', `decision=${r.decision} reason=${r.reason}`);
  }
  line('');

  // 6. Simulated outage, MEDIUM-risk → fail-OPEN ALLOW ─────────────────
  line('6) Gateway unreachable + MEDIUM-risk (read_file) → expect ALLOW (fail-open)');
  {
    const r = await downClient.verify({ agentId: 'smoke', toolName: 'read_file', input: 'cat config' });
    check('medium-risk fails open', r.decision === 'ALLOW' && r.reason === 'gateway_unavailable_failopen', `decision=${r.decision} reason=${r.reason}`);
  }
  line('');

  // 7. Invalid key → fail-LOUD (throws), never silent ALLOW ────────────
  line('7) Invalid key + HIGH-risk → expect THROW (fail-loud, no silent ALLOW)');
  {
    let threw = false;
    let result;
    try {
      result = await badKeyClient.verify({ agentId: 'smoke', toolName: 'exec', input: 'rm -rf /' });
    } catch (e) {
      threw = true;
      pass(`threw as expected — ${e?.name}: ${e?.message}`);
    }
    if (!threw) fail(`did NOT throw — returned decision=${result?.decision} (this would be the old silent-ALLOW bug)`);
  }
  line('');

  // 8. init E2E: setup → real count → idempotency → status ─────────────
  line('8) init E2E (setupShield) → real count, idempotent, status');
  {
    const s1 = await client.setupShield({ hostname: hostname() });
    const total1 = (s1.policies_activated ?? 0) + (s1.policies_created ?? 0);
    check('setup succeeded', s1.success === true && total1 > 0, `activated=${s1.policies_activated} created=${s1.policies_created} total=${total1} agent="${s1.agent_name}"`);
    check('reports 8 rules (B10 truth)', total1 === 8, `total=${total1} (warn if ≠ 8 → system-policy seeding gap)`, { hard: false });

    const s2 = await client.setupShield({ hostname: hostname() });
    const total2 = (s2.policies_activated ?? 0) + (s2.policies_created ?? 0);
    check('idempotent on re-run', s2.success === true, `2nd run total=${total2} (created should drop to ~0)`);

    const st = await client.getShieldStatus();
    check('status lists active policies', Array.isArray(st.policies) && st.policies.length > 0, `shield_active=${st.shield_active} agents=${st.agent_count} policies=${st.policies?.length}`);
    line('     active policies:');
    for (const p of st.policies ?? []) line(`       • ${p.name} → ${p.action} (${p.source})`);
  }
  line('');
} catch (e) {
  fail(`unexpected error: ${e?.stack || e?.message || e}`);
}

line('────────────────────────────────────────────────────');
if (hardFailures === 0) {
  line('✅ Live smoke PASSED (all hard checks).');
  process.exit(0);
} else {
  line(`❌ Live smoke FAILED: ${hardFailures} hard check(s) failed.`);
  process.exit(1);
}
