# agent-shield

**Your agent runs 24/7. Do you know what it's doing right now?**

agent-shield shows you everything your OpenClaw agent does, blocks dangerous actions before they execute, and masks your personal data. One command. Zero config.

## What it does

Before executing any HIGH-RISK tool call, check with the governance API. The API returns:
- **ALLOW** — proceed normally
- **BLOCK** — do NOT execute. Tell the user why.
- **MODIFY** — use the sanitized version instead

## When to check

ALWAYS call `governance_check` before these tool categories:

### 🔴 Must check (HIGH-RISK)
- `exec`, `shell`, `bash`, `run_command` — any shell execution
- `delete_file`, `remove_file`, `write_file` — destructive file operations
- `git_push`, `git_push_force`, `git_reset_hard` — irreversible git operations
- `http_request`, `fetch_url`, `curl` — outbound network requests
- `install_package`, `npm_install`, `pip_install` — package installation
- `send_email`, `send_message`, `post_tweet` — outbound communications
- `transfer`, `payment`, `purchase` — financial operations

### 🟡 Should check (MEDIUM-RISK)
- `read_file`, `search_files` — file reads (may contain secrets)
- `memory_write`, `save_context` — persistent storage
- `navigate`, `fill_form` — browser automation

### 🟢 Skip (LOW-RISK)
- `read_file` on non-sensitive paths
- `list_directory`
- Conversation responses (no tool call)

## How to check

Use the `governance_check` tool with:
- `tool_name`: The tool you're about to call (e.g., "exec")
- `input`: The exact input/command you plan to execute
- `context`: (Optional) Why you need this action

## Handling decisions

```
If decision == "BLOCK":
  - Do NOT execute the tool call
  - Tell the user: "⛔ Blocked by Shield: {reason}"
  - Suggest a safe alternative if possible

If decision == "MODIFY":
  - Use modified_input instead of original input
  - Tell the user: "🔄 Input was sanitized by Shield"

If decision == "ALLOW":
  - Proceed normally

If decision has _fallback == true:
  - Governance API was unreachable
  - Proceed with caution for MEDIUM-RISK
  - For HIGH-RISK: warn the user that governance is offline
```

## Setup

```bash
# Install
npm install -g @PLACEHOLDER_SCOPE/agent-shield

# Set environment variables
export PALVERON_API_KEY="your-api-key"     # From dashboard
export PALVERON_API_URL="your-api-url"     # API endpoint
export OPENAI_API_KEY="sk-..."          # Your LLM key (BYOM)

# Initialize
npx agent-shield init
```

## What's protected

After initialization, 8 rules automatically protect your agent:

1. **Secret-Exfiltration-Shield** — Blocks API keys, private keys, JWTs in output
2. **Shell-Injection-Guard** — Blocks curl|bash, chmod 777, eval()
3. **Destructive-Actions-Shield** — Blocks rm -rf, DROP TABLE, git push --force
4. **Package-Install-Watchdog** — Requires approval for package installs
5. **Social-Media-Output-Guard** — Anonymizes PII in outbound messages
6. **GDPR Privacy Shield** — Anonymizes personal data (emails, phones, IBANs)
7. **Circuit Breaker** — Stops agent loops (>100 requests/minute)
8. **Fiscal Authority Limit** — Requires approval for transactions >€1,000

## Dashboard

Open your dashboard to see:
- Every tool call your agent made
- Which actions were blocked and why
- PII instances that were masked
- Estimated LLM costs
- Timeline view — searchable, minute by minute

## Blockchain proof

Set up a Flare wallet in your dashboard for cryptographic proof of every governance decision. Without wallet: local SHA-256 hashes (tamper-detectable).
