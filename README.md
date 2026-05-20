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
  <img src="https://img.shields.io/badge/License-Proprietary-red?style=flat-square" alt="License">
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#what-it-protects">Protection</a> ·
  <a href="#mcp-server">MCP Server</a> ·
  <a href="#circuit-breaker">Circuit Breaker</a> ·
  <a href="#architecture">Architecture</a>
</p>

---

## Why

Your agent runs 24/7. Do you know what it's doing right now?

agent-shield shows you everything your OpenClaw agent does, blocks dangerous actions before they execute, and masks your personal data. **One command. Zero config.**

---

## Quick Start

```bash
# 1. Install
npm install -g @palveron/agent-shield

# 2. Set your keys
export PALVERON_API_KEY="your-key"        # from dashboard signup
export PALVERON_API_URL="your-api-url"    # API endpoint
export OPENAI_API_KEY="sk-..."            # your own LLM key (BYOM)

# 3. Initialize
npx agent-shield init
```

That's it. 8 protection rules are now active. Restart your OpenClaw agent.

---

## What It Protects

`agent-shield init` activates 8 guardrails automatically — no configuration needed:

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

Every OpenClaw user already has an LLM API key. agent-shield's 2-pass system (Regex + AI) uses **your** key for the AI pass. Our LLM cost: zero. Your governance cost: zero on the free tier.

---

## MCP Server

agent-shield includes an MCP (Model Context Protocol) server for integration with coding tools like Cursor and Claude Code:

```bash
# Start as MCP server
npx agent-shield-mcp
```

The MCP server exposes a `governance_check` tool that your coding agent calls before executing high-risk operations. Configure it in your `.cursor/mcp.json` or Claude Code settings.

---

## Circuit Breaker

agent-shield implements a 3-state circuit breaker to ensure your agent **never stops** because of a governance outage:

| State | Behavior |
|-------|----------|
| **Closed** | Normal operation — every call goes to the Palveron API |
| **Open** | After 3 consecutive failures — returns `ALLOW` immediately, agent keeps running |
| **Half-Open** | After 30s — sends one probe request. Success → Closed. Failure → Open again |

**Fail-open by design.** If the Palveron gateway is unreachable, your agent continues with `{ decision: "ALLOW", reason: "circuit_open" }`. We never block your agent because of our downtime.

---

## CLI Commands

```bash
agent-shield init      # Initialize shield, activate 8 rules, register agent
agent-shield status    # Show connection status, active rules, circuit state
agent-shield test      # Send a test prompt through the governance pipeline
agent-shield --help    # Show all commands
```

---

## Architecture

agent-shield is a **thin client**. It contains:

- HTTP client with retry logic and circuit breaker
- CLI for initialization and status checks
- MCP server entry point for coding tool integration
- Local tool-risk classification (trivial mapping, no IP)

**What it does NOT contain:** No PII patterns, no policy evaluation engine, no guardrail logic. All intelligence lives server-side in the [Palveron Gateway](https://github.com/palveron/gateway). This protects our IP and keeps the client small and dependency-free.

```
Your Agent ──→ agent-shield (HTTP client) ──→ Palveron Gateway
                    │                              │
                    │ Circuit Breaker               │ 8 Guardrails
                    │ Fail-Open on timeout          │ PII Detection
                    │                              │ Blockchain Proof
                    ▼                              ▼
              Agent continues                Trace in Dashboard
```

---

## Environment Variables

| Variable | Required | Description |
|----------|:--------:|-------------|
| `PALVERON_API_KEY` | ✅ | Your project API key (from dashboard) |
| `PALVERON_API_URL` | ✅ | Gateway API endpoint |
| `OPENAI_API_KEY` | — | Your LLM key for AI-pass (BYOM) |

Legacy fallback: `AGENT_SHIELD_API_KEY` / `AGENT_SHIELD_API_URL` are also accepted.

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

Proprietary — © 2026 Palveron A. Podzus. All rights reserved.
