# agent-shield

**Your agent runs 24/7. Do you know what it's doing right now?**

agent-shield records everything your OpenClaw agent does, and asks you — the agent — to check high-risk actions **before** running them so dangerous ones can be stopped. It masks personal data on the way out. One command. Zero config.

**Your part of the contract:** call `governance_check` before every high-risk tool call (the list below) and honor the decision. This is how "stop it before it runs" actually works — the check only protects an action you route through it first.

## What it does

Before executing any HIGH-RISK tool call, call `governance_check`. It returns one of:
- **ALLOW** — proceed normally
- **BLOCK** — do NOT execute. Tell the user why.
- **MODIFY** — use the sanitized version instead
- **APPROVAL** — a human must approve first. Do NOT execute; tell the user approval is required.
- **ERROR** — the check could not complete (misconfig / contract error). Do NOT silently proceed on HIGH-RISK; warn the user.

## When to check

Call `governance_check` before any tool call. Every checked call is verified
**and** recorded as a trace — there is no "skip" tier. The risk level only
changes what happens if the gateway is unreachable (see below); it never skips
the check.

### 🔴 HIGH-RISK — verified; **fail-closed** (BLOCK) if the gateway is unreachable
- `exec`, `shell`, `bash`, `run_command` — any shell execution
- `delete_file`, `remove_file`, `write_file` — destructive file operations
- `git_push`, `git_push_force`, `git_reset_hard` — irreversible git operations
- `http_request`, `fetch_url`, `curl` — outbound network requests
- `install_package`, `npm_install`, `pip_install` — package installation
- `send_email`, `send_message`, `post_tweet` — outbound communications
- `transfer`, `payment`, `purchase` — financial operations

### 🟡 MEDIUM-RISK (incl. any unknown tool) — verified; **fail-open** (ALLOW) if the gateway is unreachable
- `read_file`, `search_files`, `list_directory` — file reads (may contain secrets)
- `memory_write`, `save_context` — persistent storage
- `navigate`, `fill_form` — browser automation
- any tool not in the HIGH list — treated as MEDIUM and still verified

The only thing you do **not** check is a pure conversational response (no tool call).

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

If decision == "APPROVAL":
  - Do NOT execute yet — a human must approve
  - Tell the user: "⏸ Awaiting approval (Shield): {reason}"

If decision == "ERROR":
  - The governance check failed to complete (e.g. config/contract error)
  - Do NOT silently proceed on a HIGH-RISK action
  - Tell the user: "⚠️ Governance check failed: {error}" and ask how to proceed

If decision == "ALLOW":
  - Proceed normally

If decision has _fallback == true (the gateway was unreachable):
  - HIGH-RISK actions come back as BLOCK (fail-closed) — reason
    "gateway_unavailable_failclosed". Do NOT execute; tell the user governance
    is offline and the action was blocked for safety.
  - MEDIUM/LOW-RISK actions come back as ALLOW (fail-open) — proceed, but note
    governance was briefly offline.
```

## Setup

```bash
# Install
npm install -g @palveron/agent-shield

# Set environment variables
export PALVERON_API_KEY="your-api-key"     # From dashboard
export PALVERON_API_URL="your-api-url"     # API endpoint

# Initialize
npx agent-shield init
```

> BYOM (Bring Your Own Model): configure your LLM key in the dashboard
> (Settings → Neural Gateway). It is used server-side — agent-shield does not
> read or forward an LLM key from the environment.

## What's protected

After initialization, the OpenClaw Shield rule set protects your agent (`init`
reports the exact number activated for your project):

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
