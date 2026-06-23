# BEFUND — agent-shield Spawn-Fail-Closed (Fund #5), Instrumentierungs-Diagnose

**Art:** Diagnose mit Instrumentierung. Eine dauerhafte, env-gated, secret-sichere File-Diagnose
(`src/debug-log.mjs`) + additive `dlog(...)`-Aufrufe wurden ergänzt. **Keine** Governance-Logik
geändert (Decision-Mapping, Fail-Closed-Pfad, Circuit-Breaker, Retry, Timeout, Health = byte-identisch).
Off-by-default (`AGENT_SHIELD_DEBUG_LOG_PATH` ungesetzt → No-op). 37/37 `node --test` grün.

**Branch:** `fix/openclaw-launch-sdk-contract` · **Datum:** 2026-06-23

---

## 1. Symptom (aus Handoff, nicht erneut getestet)

`openclaw chat` → `governance_check` über MCP → **`BLOCK / gateway_unavailable_failclosed`**.
Derselbe MCP-Server **direkt** (`echo … | node bin/agent-shield-mcp.mjs`) → sauber MODIFY/ANONYMIZED.
**Im Gateway-Log kein `[agent-shield]`-Eintrag** für den fehlschlagenden Turn → es erreicht **kein
HTTP-Request** das Gateway → der Fehler entsteht **client-seitig im gespawnten Prozess**.

---

## 2. Read-only Befund: WO `gateway_unavailable_failclosed` herkommt (Datei:Zeile)

Die Fail-Closed-Emission ist **eindeutig lokalisiert** (kein Raten):

- **`src/fail-policy.mjs:34`** — `export const FAIL_CLOSED_REASON = 'gateway_unavailable_failclosed';`
- **`src/fail-policy.mjs:71-81`** — `transportFallback(riskLevel, opts)` gibt
  `{ decision: 'BLOCK', reason: FAIL_CLOSED_REASON }` zurück, **wenn** `failClosedOverride(env) ||
  riskLevel === 'HIGH'`. Sonst `{ decision:'ALLOW', reason: FAIL_OPEN_REASON }`.

`transportFallback` wird aus **`src/client.mjs` an genau zwei Stellen** aufgerufen:
1. **`client.mjs:250`** — RATE_LIMITED-Zweig (SDK liefert HTTP 429 als `decision:'RATE_LIMITED'`,
   keine Exception). → Branch `rate_limited`.
2. **`client.mjs:320`** — `catch (err)`-Zweig (Z. 299), **nachdem** `isFailLoud(err)` false war
   (also **kein** 400/401, sondern Transport-/Timeout-/Circuit-Open-Fehler). → **Das ist der für
   Fund #5 relevante Pfad**: `send_email` ist HIGH-Risk → `transportFallback(HIGH)` → BLOCK.

**Schlussfolgerung (belegt):** Der Spawn-Fehler läuft durch **`client.mjs:299 catch` → `:320
transportFallback`**. Die offene Frage ist **welcher `err`** dort ankommt — und genau das entscheidet
zwischen H1–H5. Deshalb instrumentiert (nicht geraten).

---

## 3. Read-only Befund: Circuit Breaker ist SDK-INTERN (entscheidend für H1)

Der Breaker lebt **nicht** in agent-shield, sondern in `@palveron/sdk`:

- **`@palveron/sdk/dist/index.mjs`** (gespiegelt in `dist/index.js`):
  - `index.js:156-158` — `new CircuitBreaker(config.circuitBreakerThreshold ?? 5,
    config.circuitBreakerCooldown ?? 3e4)` → **Schwelle 5 Failures, Cooldown 30 000 ms**.
  - `index.js:323-324` — `if (!this.circuit.canRequest()) throw new PalveronCircuitOpenError();`
    → bei offenem Breaker wird **vor jedem HTTP** geworfen (= „kein Netzwerk-Versuch", konsistent mit
    „kein `[agent-shield]` im Gateway-Log").
  - `index.js:298` — `diagnostics().circuitState = this.circuit.getState()` (`closed|open|half-open`).
- agent-shield kann den Breaker **nur beobachten**: `client.mjs` `get circuitState()` liest
  `#sdk.diagnostics().circuitState`. Es gibt **keinen** internen Transition-Hook → die `breaker`-
  Events werden aus **Vorher/Nachher-Deltas** von `circuitState` + dem Fangen von
  `PalveronCircuitOpenError` abgeleitet (siehe §4 Event `breaker`/`gateway_call_end`).

**Wichtige Konsequenz für H1:** Die Schwelle ist **5**. Ein **einzelner** früher Fehler trippt den
Breaker **nicht**. H1 würde also ≥5 vorausgehende Fehlversuche **im selben Prozess** verlangen
(SDK-interne Retries zählen je `onFailure`). Das macht H1 **a priori weniger wahrscheinlich** als
H2/H3 (geerbtes Proxy-Env / Env-Divergenz, die schon den **ersten** Call als `transport_error` killen)
— aber der Log entscheidet es faktisch, nicht diese Plausibilität.

---

## 4. Instrumentierungs-Inventar (Event → Datei:Zeile, secret-safe)

Neues Modul **`src/debug-log.mjs`** — `dlog(event, fields)`, append-only JSONL, `seq` monoton pro
Prozess, `try/catch` (wirft nie), aktiv nur bei gesetztem `AGENT_SHIELD_DEBUG_LOG_PATH`. Secret-Helfer:
`keyMeta` (nur `{present,len}`), `sanitizeProxyUrl` (→ `host:port`, strippt `user:pass`+Pfad),
`collectProxyEnv`.

| Event | Datei:Zeile | Entscheidet | Kernfelder |
|---|---|---|---|
| `proc_start` | `bin/agent-shield-mcp.mjs:18` | H2/H3/H4 | `cwd`, `argv`, `nodeVersion`, `apiUrl`, `apiUrlEnvSeen` (beide Aliase), `apiKeyPresent`/`apiKeyLen`, `agentId`, `proxyEnv` (sanitisiert), `nodeOptions`, `failClosedOverride` |
| `mcp_msg` | `src/mcp-server.mjs:78` | H1/H5 (Reihenfolge) | `method`, `id`, bei tools/call: `mcpToolName`, `toolName`, `argKeys`, `argBytes` (**keine** arg-Werte) |
| `gateway_call_start` | `client.mjs:222` (verify), `:335` (health) | H1 (Breaker-State **vor** Call) | `kind`, `url`, `attempt:0`, `breakerState` |
| `gateway_call_end` | `client.mjs:237`/`302` (verify), `:339`/`344` (health) | **H1 vs H2/H3** | `outcome` ∈ {`http_ok`(+`httpStatus`,`decision`), `transport_error`(+`errName`,`errCode`,`errMessage`), `breaker_open_shortcircuit`, `timeout`(+`timeoutMs`), `http_error`}, `elapsedMs` |
| `breaker` | `client.mjs:193` (via `#emitBreakerDelta`, gerufen `:236/301/338/343`) | **H1 direkt** | `from`, `to`, `observed` (Call-Ergebnis als Kontext) |
| `failclosed_emit` | `client.mjs:254` (rate_limited), `:325` (catch) | Kausalkette schließen | `reason` (gateway_unavailable_failclosed/…failopen), `decision`, `branch` (= outcome), `riskLevel`, `errName` |
| `proc_fatal` | `bin/agent-shield-mcp.mjs:37` | Start-Crash | `errName`, `errMessage` |

`outcome`-Klassifikation: `client.mjs:34 classifyErrorOutcome(err)` mappt
`PalveronCircuitOpenError → breaker_open_shortcircuit`, `PalveronTimeoutError → timeout`,
`PalveronValidation/Authentication → http_error`, sonst `transport_error` (nutzt `err.name`/`err.code`,
z. B. `ECONNREFUSED`/`ENOTFOUND`/`ETIMEDOUT`/`UND_ERR_CONNECT_TIMEOUT`).

**Korrelation MCP-Call ↔ Gateway-Call:** über `pid` + `seq`-Adjazenz. Node ist single-threaded und die
Handler awaiten sequenziell (`handleMessage` → `handleToolCall` → `client.verify`), daher folgt der
`gateway_call_start` eines Turns **unmittelbar** (nächstes `seq`, gleicher `pid`) auf das `mcp_msg`
mit dem auslösenden `id`. Bewusst **kein** durchgereichter Korrelations-Parameter, um `verify()`
byte-identisch zu lassen (Wire-Payload unverändert).

---

## 5. Entscheidungs-Matrix (welche Log-Signatur beweist welche Hypothese)

Nach einem Spawn-Lauf + Direkt-Kontroll-Lauf in **derselben** Logdatei (zwei `pid`):

| Beobachtung im Spawn-`pid` | Verdikt |
|---|---|
| Turn-`gateway_call_end.outcome = transport_error` mit `errCode` (z. B. `ECONNREFUSED`/`UND_ERR_*`) **schon beim ersten** Call, **und** `proc_start.proxyEnv` nicht leer (Direkt-Lauf leer) | **H2** — geerbtes Proxy-Env bricht den Transport |
| `proc_start.apiUrl`/`apiKeyLen`/`agentId` weichen vom Direkt-Lauf ab (leer/anders) | **H3** — Env-Sicht ≠ `mcp show` |
| `proc_start.cwd` ≠ `C:\Projekte\agent-shield` **und** ein Config/`.env`-relativer Read schlägt fehl | **H4** — cwd-Auflösung |
| Turn-`gateway_call_end.outcome = breaker_open_shortcircuit` **und** ≥1 früherer `gateway_call_end` (gleicher `pid`) = `transport_error`/`timeout` **plus** `breaker closed→open` | **H1** — Breaker durch frühere Fehler getrippt; Ursache ist der **frühere** Fehler (selbst wieder H2/H3) |
| `mcp_msg`-Reihenfolge zeigt einen Gateway-auslösenden Call **vor** dem Turn (probe/list), der fehlschlug | **H5** — Handshake-/Reihenfolge-Race |
| Direkt-`pid`: dieselbe `tools/call`-Probe → `gateway_call_end.outcome = http_ok`, `decision = MODIFY/ANONYMIZED` | Kontroll-Beleg: Code/Mapping/Netz ok (deckt sich mit Vorbefund) |

**Erwartung (Plausibilität, nicht Beweis):** H2/H3 am wahrscheinlichsten (erster Call schon
`transport_error`, kein `[agent-shield]` im Gateway-Log), H1 nachrangig (Schwelle 5). Der Log
entscheidet.

---

## 6. Beobachtungs-Protokoll (Betreiber = Verifier, nach Commit)

Ziel: **eine** Datei mit Spawn-Lauf UND Direkt-Kontroll-Lauf.

**(a) Spawn-Kontext** — `AGENT_SHIELD_DEBUG_LOG_PATH` in die OpenClaw-MCP-Registrierung aufnehmen:
```powershell
openclaw mcp remove agent-shield
openclaw mcp add agent-shield --command node --arg C:/Projekte/agent-shield/bin/agent-shield-mcp.mjs `
  --env PALVERON_API_URL=<URL> --env PALVERON_API_KEY=<KEY> --env AGENT_SHIELD_AGENT_ID=<ID> `
  --env AGENT_SHIELD_DEBUG_LOG_PATH=C:/Projekte/agent-shield/.debug/spawn.jsonl
openclaw mcp show agent-shield   # Debug-Env bestätigen
openclaw chat                    # einen governance_check-Turn auslösen (send_email/Newsletter)
```

**(b) Direkter Kontroll-Lauf** — gleiche Env, **gleiches** Logfile, frischer Prozess:
```powershell
$env:PALVERON_API_URL="<URL>"; $env:PALVERON_API_KEY="<KEY>"; $env:AGENT_SHIELD_AGENT_ID="<ID>"; $env:AGENT_SHIELD_DEBUG_LOG_PATH="C:/Projekte/agent-shield/.debug/spawn.jsonl"
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"governance_check","arguments":{"tool_name":"send_email","input":"Newsletter-Entwurf an test@example.com"}}}' | node C:/Projekte/agent-shield/bin/agent-shield-mcp.mjs
```

**(c) Lesen:** `Get-Content C:/Projekte/agent-shield/.debug/spawn.jsonl`
(`.debug/` ist gitignored — nie committen.)

---

## 7. Was der Log eindeutig beantworten muss (→ Basis fürs Fix-Goal)

1. **proc_start:** Sieht der Spawn `apiUrl`/`apiKeyLen`/`agentId` korrekt? (H3) Gibt es
   `proxyEnv`/`nodeOptions`, die der Direkt-Lauf nicht hat? (H2/H4)
2. **seq/mcp_msg:** Gab es **vor** dem fehlschlagenden `tools/call` einen früheren Gateway-Call? (H1/H5)
3. **Turn-`gateway_call_end.outcome`:** `breaker_open_shortcircuit` (H1) vs `transport_error`+`errCode`
   (H2/H3) vs `timeout`?
4. **`breaker`-Events:** Hat ein früherer Call den Breaker `closed→open` getrippt? Mit welchem `observed`?
5. **`failclosed_emit.branch`:** Aus welchem outcome kam `gateway_unavailable_failclosed`?
6. **Direkt vs. Spawn (zwei `pid`):** Worin unterscheiden sie sich konkret?

Der **Fix** (eigenes Folge-Goal) folgt aus diesen Fakten — z. B. Proxy-Bypass für den Gateway-Host,
Env-Propagation-Fix, Breaker-Reset/Half-Open-Strategie oder Handshake-Ordering — **nicht vorher**.

---

## 8. Akzeptanzgates (erfüllt)

- [x] `AGENT_SHIELD_DEBUG_LOG_PATH` ungesetzt → exakt voriges Verhalten, kein File-IO (Test
  „no-op when unset"; 31 bestehende Tests unverändert grün).
- [x] `dlog` wirft nie (Test „unwritable path → SURVIVED"; internes try/catch).
- [x] Keine Decision-/Breaker-/Retry-/Timeout-Logik verändert — Diff ist rein additiv (`dlog`-Aufrufe +
  neues Modul + Diagnose-Helfer; `transportFallback`/`isFailLoud`/Mapping unberührt).
- [x] Kein Secret im Log: Key nur `apiKeyPresent`/`apiKeyLen`; **keine** `arguments`-Werte (nur
  `argKeys`/`argBytes`); Proxy-Werte auf `host:port` sanitisiert (Test deckt alle drei ab).
- [x] Zero neue Dependency — nur `node:fs`/`node:os`/`node:path`.
- [x] `node --test` grün: **37/37** (31 bestehend + 6 neue debug-log-Tests).
- [x] Emissions-Stellen mit Datei:Zeile dokumentiert (§2/§4).

---

## 9. Nebenfunde (read-only, nicht gefixt)

- **`attempt` ist immer 0** aus agent-shield-Sicht: die SDK macht ihre Retries **intern**
  (`index.js` retry-Schleife) — agent-shield sieht nur das Endergebnis/den End-Fehler. Der Log
  vermerkt das bewusst (`attempt:0`), damit niemand fälschlich „nur 1 Versuch" liest.
- **MCP-Client `maxRetries: 1`** (`mcp-server.mjs:38`) + SDK-Default-Retries: bei wiederholtem
  Transport-Fehler summieren sich `circuit.onFailure()`-Aufrufe → kann über mehrere Turns die
  Schwelle 5 erreichen (relevant, falls H1 sich doch zeigt).
- **Bekannt offen (eigene Goals, hier nicht berührt):** `init` schreibt invalides Top-Level
  `mcpServers` + nicht-publiziertes `npx` (Fund #2); CLI `status` zeigt 9 statt 15
  (SYSTEM_SHIELD-Filter); `test`-Erwartung „Dangerous→BLOCK" veraltet (Policy=APPROVAL);
  `pv_live_`/Resend-Key-Rotation vor Launch.
