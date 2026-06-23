<p align="center">
  <img alt="Palveron" src="https://palveron.com/images/brand/palveron-logo-dark.png" width="280">
</p>

<h3 align="center">Control Layer for OpenClaw Agents</h3>

<p align="center">
  See what your agent does. Control what it's allowed to do. Prove it on-chain.
</p>

<p align="center">
  <a href="https://palveron.com"><img src="https://img.shields.io/badge/Website-palveron.com-0066FF?style=flat-square" alt="Website"></a>
  <a href="https://docs.palveron.com"><img src="https://img.shields.io/badge/Docs-docs.palveron.com-0066FF?style=flat-square" alt="Docs"></a>
  <img src="https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License">
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#what-it-protects">Protection</a> ·
  <a href="#mcp-server">MCP Server</a> ·
  <a href="#resilience--fail-policy">Fail Policy</a> ·
  <a href="#architecture">Architecture</a>
</p>

---

## Why

Your agent runs 24/7. Do you know what it's doing right now?

agent-shield gives your OpenClaw agent a governance check it calls **before** every
high-risk action, records every check, and masks personal data on the way out.
**One command. Zero config.**

> **How enforcement works (the honest version).** agent-shield instructs your agent
> (via its skill + an MCP `governance_check` tool) to check high-risk actions
> *before* running them, and records every check for your dashboard. It is
> **advisory in-path today**: the agent decides to call the check. Hard,
> unbypassable in-path enforcement via an OpenClaw `before_tool_call` hook is on
> the roadmap. What is already hard today: when a check *is* called and returns
> `BLOCK`, the skill tells the agent not to execute — and if our gateway is
> unreachable during a **high-risk** action, agent-shield fails **closed**
> (see [Resilience & Fail Policy](#resilience--fail-policy)).

---

## Quick Start

```bash
# 1. Install
npm install -g @palveron/agent-shield

# 2. Set your keys
export PALVERON_API_KEY="your-key"        # from dashboard signup
export PALVERON_API_URL="your-api-url"    # API endpoint

# 3. Initialize
npx agent-shield init
```

That's it. Your OpenClaw Shield rule set is now active. Restart your OpenClaw agent.

`init` prints the exact number of rules it activated for your project (it does not
assume a fixed count). Run `agent-shield status` to see them live.

---

## What It Protects

`agent-shield init` activates the OpenClaw Shield rule set automatically — no
configuration needed:

| Rule | Detects | Action |
|------|---------|--------|
| **High-Speed Circuit Breaker** | Agent loops (>100 req/min) | BLOCK + Suspend |
| **Destructive Action Shield** | `rm -rf`, `DROP TABLE`, `git push --force` | BLOCK |
| **GDPR Privacy Guard** | Emails, phone numbers, IBANs, SSNs | ANONYMIZE |
| **Fiscal Authority Limit** | Transactions > €1,000 | APPROVAL |
| **Secret Exfiltration Shield** | API keys, private keys, JWTs in output | BLOCK |
| **Shell Injection Guard** | `curl\|bash`, `chmod 777`, `eval()` | BLOCK |
| **Social Media Output Guard** | PII + secrets in outbound messages | ANONYMIZE |
| **Package Install Watchdog** | npm/pip/apt install from unknown sources | APPROVAL |

---

## What Happens Next

After installation, open your [Palveron Dashboard](https://palveron.com) the next morning. You'll see:

> *Your agent made 847 tool calls last night.*
> *12 classified as HIGH RISK. 3 were BLOCKED. 47 PII instances masked.*
> *Every tool call, every minute, searchable.*

That's the moment you understand what your agent actually does — not because we say "governance", but because you **see** it for the first time.

---

## BYOM — Bring Your Own Model

agent-shield's analysis runs **server-side**. Deterministic guardrails (PII, secrets,
shell/destructive patterns) need no LLM at all. For the optional AI analysis pass, the
gateway uses **your** model key — but you configure it **in the dashboard**
(**Settings → Neural Gateway**), where it is stored encrypted and used per project.

> agent-shield does **not** read or forward an LLM API key from your shell. There is
> no `OPENAI_API_KEY` plumbing in the client — the gateway never received it. Set your
> BYOM key once in the dashboard and it applies to every check.

---

## MCP Server

agent-shield ships an MCP (Model Context Protocol) server exposing a single
`governance_check` tool that your agent calls before high-risk operations.

`init` wires this into your `openclaw.json` automatically. To configure it manually
(OpenClaw, Cursor, Claude Code), use this exact invocation — `agent-shield-mcp` is a
**bin inside `@palveron/agent-shield`**, not a standalone package:

```json
{
  "mcpServers": {
    "agent-shield": {
      "command": "npx",
      "args": ["-y", "-p", "@palveron/agent-shield", "agent-shield-mcp"],
      "env": {
        "PALVERON_API_URL": "your-api-url",
        "PALVERON_API_KEY": "your-key"
      }
    }
  }
}
```

### Which package do I need?

| You want… | Use | Tool(s) |
|-----------|-----|---------|
| OpenClaw zero-config governance + CLI setup | **`@palveron/agent-shield`** (this package) | `governance_check` |
| A generic MCP server for Cursor / Claude Code | [`@palveron/mcp-server`](https://www.npmjs.com/package/@palveron/mcp-server) | `palveron_verify`, `palveron_check_tool_call`, `palveron_list_policies` |

Both talk to the same Palveron Gateway. `agent-shield` is the OpenClaw-focused,
zero-config path; `@palveron/mcp-server` is the general-purpose coding-assistant path.

---

## Resilience & Fail Policy

agent-shield is built on [`@palveron/sdk`](https://www.npmjs.com/package/@palveron/sdk),
which provides request retries and a circuit breaker. On top of that, agent-shield
applies a **tiered fail policy** so an outage on our side never silently disables your
governance:

| Situation | Behavior |
|-----------|----------|
| Gateway returns a verdict | The real decision is used (`ALLOW` / `BLOCK` / `MODIFY` / `APPROVAL`) |
| **Contract / auth error** (bad request, invalid key) | **Fail LOUD** — the error is surfaced; **never** a silent `ALLOW` |
| Gateway unreachable, **HIGH-risk** action (shell, exec, delete, `git_push`, destructive, secret-exfil) | **Fail CLOSED** — `BLOCK`. We do not let a dangerous action run unchecked during our downtime |
| Gateway unreachable, MEDIUM-risk action (incl. any unknown tool) | **Fail OPEN** — `ALLOW`, so a transient outage never blocks ordinary work |

Set `AGENT_SHIELD_FAIL_CLOSED=true` to fail closed for **all** risk levels when the
gateway is unreachable (maximum safety; availability traded away).

> This is a deliberate change from a blanket "always fail open" stance. For the
> dangerous class of actions, security beats availability: if we can't check it, we
> don't run it.

---

## CLI Commands

```bash
agent-shield init      # Initialize shield, activate rules, register agent
agent-shield status    # Show connection status, active rules, 24h stats
agent-shield test      # Send test prompts through the governance pipeline
agent-shield --help    # Show all commands
```

---

## Troubleshooting — spawn diagnostics

When agent-shield runs **as a spawned MCP subprocess** (OpenClaw, Cursor, Claude
Code, …), the host swallows its stderr, so a normal log is invisible. For cases
where a governed call behaves differently under the host than when invoked
directly, set `AGENT_SHIELD_DEBUG_LOG_PATH` to a file path and agent-shield
appends an ordered, append-only JSONL event log (process start + env snapshot,
each MCP message, every gateway call with its outcome, circuit-breaker
transitions, and the fail-closed branch):

```bash
AGENT_SHIELD_DEBUG_LOG_PATH=./.debug/spawn.jsonl node bin/agent-shield-mcp.mjs
```

- **Off by default** — unset means zero file IO and no behavioral difference.
- **Never affects governance** — diagnostics can't throw; on any IO error they
  go silent. Correctness beats diagnosis.
- **Secret-safe** — the API key appears only as length/presence, tool-call
  arguments are never logged (only their key names + byte size), and proxy URLs
  are reduced to `host:port`.

Add the same env var to the host's MCP registration to capture a real spawn run,
then compare it against a direct run pointed at the same log file. The `.debug/`
folder is gitignored.

---

## Architecture

agent-shield is a **thin client**. It contains:

- A small facade over [`@palveron/sdk`](https://www.npmjs.com/package/@palveron/sdk)
  (which owns the verify contract, retries, and circuit breaker)
- The tiered fail policy and OpenClaw Shield setup/status calls
- CLI for initialization and status checks
- MCP server entry point for agent / coding-tool integration
- Local tool-risk classification (trivial mapping, no IP)

**What it does NOT contain:** No PII patterns, no policy evaluation engine, no guardrail
logic. All intelligence lives server-side in the
[Palveron Gateway](https://github.com/palveron/gateway). This keeps the client small and
its single dependency (`@palveron/sdk`) is the one source of truth for the API contract —
no second client implementation to drift from the server.

```
Your Agent ──→ agent-shield ──→ @palveron/sdk ──→ Palveron Gateway
                    │                                  │
                    │ Tiered fail policy                │ Guardrails
                    │ (HIGH → fail-closed)              │ PII Detection
                    │                                  │ Blockchain Proof
                    ▼                                  ▼
              Agent decision                     Trace in Dashboard
```

---

## Environment Variables

| Variable | Required | Description |
|----------|:--------:|-------------|
| `PALVERON_API_KEY` | ✅ | Your project API key (from dashboard) |
| `PALVERON_API_URL` | ✅ | Gateway API endpoint |
| `AGENT_SHIELD_FAIL_CLOSED` | — | `true` forces fail-closed for all risk levels when the gateway is unreachable. Default: tiered |

Legacy fallback: `AGENT_SHIELD_API_KEY` / `AGENT_SHIELD_API_URL` are also accepted.
BYOM model keys are configured in the dashboard (**Settings → Neural Gateway**), not here.

---

## Live smoke (`scripts/smoke-live.mjs`)

An end-to-end smoke that runs the eight launch checks against a real gateway. It
is **not** shipped in the npm package.

> ⚠️ **Run it only against a dedicated, disposable project.** Check #8 (`init` /
> `setupShield`) **writes policies and an agent** into the project. There is no
> test or sandbox key today — every Palveron key is a live `pv_live_` key, so
> isolation comes from targeting a **separate throwaway project**, not from a key
> prefix.

Setup:

1. Create a dedicated throwaway project in the dashboard (e.g. named
   `agent-shield-smoke-throwaway`).
2. `cp .env.smoke.example .env.smoke` and fill in that project's `pv_live_` key
   and name. `.env.smoke` is gitignored.
3. Run it:

   ```bash
   node --env-file=.env.smoke scripts/smoke-live.mjs
   ```

The script refuses to run unless both `PALVERON_API_KEY` and
`PALVERON_SMOKE_PROJECT` are set — naming the throwaway project is the conscious
confirmation that you are pointing at a disposable target. Exit code `0` means
all hard checks passed.

---

## Tiers

| | Community | Pro | Business | Enterprise |
|--|-----------|-----|----------|-----------|
| **Requests/mo** | 1,000 | 10,000 | 100,000 | Unlimited |
| **Agents** | 3 | 10 | 50 | Unlimited |
| **Shield Rules** | 8 | 8 + custom | Unlimited | Unlimited |
| **Blockchain Proof** | Own wallet | Managed | Managed | Managed |
| **Trace Retention** | 30 days | 90 days | 365 days | 365 days |

---

## Links

- **Website:** [palveron.com](https://palveron.com)
- **Documentation:** [docs.palveron.com](https://docs.palveron.com)
- **Dashboard:** [palveron.com/dashboard](https://palveron.com/dashboard)
- **Gateway (Rust backend):** [github.com/palveron/gateway](https://github.com/palveron/gateway)
- **Platform (Dashboard):** [github.com/palveron/platform](https://github.com/palveron/platform)

---

## License

MIT — © 2026 Palveron A. Podzus. This thin client is open source. The governance
engine (the Palveron Gateway) is proprietary.
