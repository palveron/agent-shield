# agent-shield

> Control Layer for OpenClaw Agents — See. Control. Prove.

Your agent runs 24/7. Do you know what it's doing right now?

agent-shield shows you everything your OpenClaw agent does, blocks dangerous actions before they execute, and masks your personal data. **One command. Zero config.**

## Quick Start

```bash
# 1. Install
npm install -g @palveron/agent-shield

# 2. Set your keys
export PALVERON_API_KEY="your-key"        # from dashboard signup
export PALVERON_API_URL="your-api-url"    # API endpoint
export OPENAI_API_KEY="sk-..."         # your own LLM key (BYOM)

# 3. Initialize
npx agent-shield init
```

That's it. 8 protection rules are now active. Restart your OpenClaw agent.

## What happens next?

Your agent makes tool calls as usual. Before every HIGH-RISK action (shell commands, file deletions, package installs, outbound messages), agent-shield checks with the governance API:

- **ALLOW** — proceed normally
- **BLOCK** — dangerous action stopped, user notified
- **MODIFY** — input sanitized (PII masked, secrets removed)

Open your dashboard the next morning. You'll see everything your agent did overnight.

## How it works

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  OpenClaw    │────▶│ agent-shield │────▶│  Governance API  │
│  Agent       │◀────│ (MCP Server) │◀────│  (Rust Engine)   │
│              │     │              │     │                  │
│ "exec rm -rf"│     │ governance_  │     │ Policy Match     │
│              │     │ check()      │     │ PII Detection    │
│              │     │              │     │ Risk Analysis    │
│ ⛔ BLOCKED   │     │ BLOCK        │     │ Blockchain Proof │
└─────────────┘     └──────────────┘     └─────────────────┘
```

## BYOM: Bring Your Own Model

You already have an LLM API key. agent-shield uses YOUR key for the AI analysis pass. Our cost for your LLM usage: **zero**.

| Component | Runs where | Your cost |
|-----------|-----------|-----------|
| Regex patterns | Server (Rust) | Included |
| AI analysis | Server (via your key) | Your LLM costs |
| Policy engine | Server (Rust) | Included |
| Blockchain proof | Flare network | ~€0.001/tx |

## Protection rules (auto-activated)

| Rule | Detects | Action |
|------|---------|--------|
| Secret-Exfiltration-Shield | API keys, private keys, JWTs in output | BLOCK |
| Shell-Injection-Guard | curl\|bash, chmod 777, eval() | BLOCK |
| Destructive-Actions-Shield | rm -rf, DROP TABLE, git push --force | BLOCK |
| Package-Install-Watchdog | npm/pip/apt install | APPROVAL |
| Social-Media-Output-Guard | PII in outbound messages | ANONYMIZE |
| GDPR Privacy Shield | Emails, phones, IBANs, SSNs | ANONYMIZE |
| Circuit Breaker | Agent loops (>100 req/min) | BLOCK |
| Fiscal Authority Limit | Transactions >€1,000 | APPROVAL |

## CLI Commands

```bash
npx agent-shield init       # Setup Shield + register agent
npx agent-shield status     # 24h stats + active policies
npx agent-shield test       # Run test governance checks
npx agent-shield help       # Usage information
```

## Programmatic Usage

```javascript
import { ShieldClient } from '@palveron/agent-shield';

const client = new ShieldClient({
  apiUrl: process.env.PALVERON_API_URL,
  apiKey: process.env.PALVERON_API_KEY,
  llmApiKey: process.env.OPENAI_API_KEY,
});

// Check before executing
const result = await client.verify({
  agentId: 'my-agent',
  toolName: 'exec',
  input: 'rm -rf /tmp/build',
});

if (result.decision === 'BLOCK') {
  console.log(`Blocked: ${result.reason}`);
} else {
  // Safe to execute
}
```

## Tiers

| | Community | Pro | Business | Enterprise |
|--|-----------|-----|----------|------------|
| Price | Free | €49/mo | €499/mo | Custom |
| Requests/mo | 1,000 | 10,000 | 100,000 | Unlimited |
| Agents | 3 | 10 | 50 | Unlimited |
| Blockchain | Own wallet | Managed | Managed | Managed |
| Support | Community | Email | Priority | Dedicated |

## EU AI Act

Automatically covered: Art. 5 (Prohibited Practices), Art. 9 (Risk Management), Art. 12 (Record-Keeping), Art. 14 (Human Oversight). Full compliance dashboard included.

## Links

- [Dashboard](https://palveron.com)
- [Documentation](https://palveron.com/docs/openclaw)
- [API Reference](https://palveron.com/docs/api)

## License

MIT — this package is open source. The governance engine is proprietary.
