// test/command-name-gate.test.mjs
// GOAL "Ein Befehl: palveron shield" (01.09.2026) — Wächter gegen das
// Wiederauftauchen des alten Befehlsnamens. Erweitert am 02.09.2026 (GOAL
// "Befehlsschreibweise, Wächtermuster, tokenlose Veröffentlichung") um den
// ROH-Zähler. Läuft im normalen `npm test` (node --test) mit — kein eigenes
// Skript, kein Auslöser, der vergessen wird.
//
// Was es prüft: Jede Textfläche dieses Repositoriums (Dateisystem-Scan mit
// den dokumentierten Ausschlüssen unten) trägt
//   (1) NULL Treffer des ALTEN Befehlsmusters — `agent-shield init|status|
//       test|help` als Kommando sowie `agent-shield-mcp` als ausführbarer
//       Name —,
//   (2) mehr als null Treffer des NEUEN Musters (`palveron shield` als
//       Kommando bzw. als npx-args-Folge `'palveron', 'shield'`) und
//   (3) NULL Treffer des ROH-Musters: `npx` unmittelbar gefolgt von einem
//       der vier unscoped Namen `palveron`, `agent-shield`, `palveron-mcp`,
//       `agent-shield-mcp`.
// Sind (1) und (2) beide null, hat das Gate nichts gemessen und schlägt fehl.
//
// Was ein Verstoß bedeutet:
//   (1) Eine Fläche (Code, Hilfe, README, SKILL, Test) bewirbt oder startet
//       wieder den alten Namen — ein Kunde bekäme ein Kommando gezeigt, das
//       das Paket nicht mehr trägt. Das Paket wurde vor der ersten
//       Veröffentlichung umbenannt; es gibt bewusst keinen Alias.
//   (3) `npx` gefolgt von `palveron` schlägt kein Unterkommando nach, es sucht ein
//       npm-Paket namens `palveron`. Dieses Paket gehört uns nicht (02.09.:
//       unregistriert). Wer den Namen registriert, bekommt bei jedem
//       Anleitungsbefolger einen Prozessstart mit PALVERON_API_KEY im Env.
//       `palveron` ist das bin INNERHALB von @palveron/agent-shield; die
//       einzige zulässige npx-Form ist `npx -p @palveron/agent-shield
//       palveron shield …` (sie beginnt nach `npx` mit `-p`, nicht mit einem
//       Namen). Das Gate vom 01.09. hat die Form `npx` + `palveron shield init`
//       als Treffer des NEUEN Musters festgeschrieben und den Fehler damit
//       als richtig gemessen — deshalb hier die eigene Negativprobe.
//
// Ausschlüsse, je begründet:
//   node_modules/, .git/  — fremder bzw. generierter Bestand
//   .debug/               — gitignorierte Laufzeit-/Nachweisreste (das
//                           historische harness.mjs trägt den Altnamen)
//   .env.smoke            — gitignorierte lokale Konfiguration
//   test/command-name-gate.test.mjs — dieses Gate selbst (trägt die alten
//                           und die ROH-Muster als Messsonden)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.debug']);
const EXCLUDED_FILES = new Set([
  '.env.smoke',
  join('test', 'command-name-gate.test.mjs'),
]);

/** Altes Befehlsmuster: Kommandoformen + ausführbarer MCP-Name. */
const OLD_PATTERNS = [
  /agent-shield (init|status|test|help)/g,
  /agent-shield-mcp/g,
];

/** Neues Muster: Kommandoform und npx-args-Folge. */
const NEW_PATTERNS = [
  /palveron shield/g,
  /(['"])palveron\1,\s*(['"])shield\2/g,
];

/**
 * ROH-Muster: `npx` + Whitespace + einer der vier unscoped Namen. Die
 * längeren Namen stehen vorn, damit jeder Treffer genau einmal zählt.
 */
const RAW_NPX_PATTERNS = [
  /npx\s+(palveron-mcp|agent-shield-mcp|palveron|agent-shield)\b/g,
];

function corpusFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(REPO_ROOT, abs);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) corpusFiles(abs, out);
    } else if (!EXCLUDED_FILES.has(rel)) {
      out.push(abs);
    }
  }
  return out;
}

function countMatches(content, patterns) {
  let n = 0;
  for (const p of patterns) n += content.match(p)?.length ?? 0;
  return n;
}

function assertCorpusPlausible(files) {
  assert.ok(
    files.length > 15,
    `Korpus verdächtig klein (${files.length} Dateien) — Scan defekt?`,
  );
}

test('the old command name is gone and the new one is present (two numbers)', () => {
  // Positive Kontrollproben: jedes Muster MUSS seine synthetische Verletzung
  // treffen — ein Muster, das die eigene Probe verfehlt, misst nichts.
  assert.equal(countMatches('run agent-shield init now', [OLD_PATTERNS[0]]), 1);
  assert.equal(countMatches('spawns agent-shield-mcp', [OLD_PATTERNS[1]]), 1);
  assert.equal(countMatches('palveron shield init', [NEW_PATTERNS[0]]), 1);
  assert.equal(countMatches(`args: ['palveron', 'shield', 'mcp']`, [NEW_PATTERNS[1]]), 1);

  const files = corpusFiles(REPO_ROOT);
  assertCorpusPlausible(files);

  let oldTotal = 0;
  let newTotal = 0;
  const violations = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const oldHits = countMatches(content, OLD_PATTERNS);
    if (oldHits > 0) {
      oldTotal += oldHits;
      violations.push(`${relative(REPO_ROOT, file)}: ${oldHits}× altes Befehlsmuster`);
    }
    newTotal += countMatches(content, NEW_PATTERNS);
  }

  // Die zwei Zahlen des Gates — beide null hieße: nichts gemessen.
  console.log(
    `command-name-gate: ${files.length} Dateien geprüft, alte Befehlsmuster: ${oldTotal} (Soll 0), neues Muster: ${newTotal} (Soll > 0)`,
  );
  assert.ok(
    newTotal > 0,
    'Kein Treffer des neuen Musters "palveron shield" — das Gate misst nichts (Korpus/Muster prüfen)',
  );
  assert.equal(
    oldTotal,
    0,
    `Alter Befehlsname wieder im Repositorium:\n${violations.join('\n')}`,
  );
});

test('npx is never followed by an unscoped package name (raw counter, with counter-probe)', () => {
  // Pflicht-Gegenprobe: dieselbe Zeichenkette einmal sauber (0) und einmal
  // absichtlich verletzt (1). Reagiert die Zahl nicht, misst das Muster
  // nichts. Konstruiert im Test, nicht aus dem Korpus gelesen.
  const clean = 'palveron shield init';
  assert.equal(countMatches(clean, RAW_NPX_PATTERNS), 0);
  assert.equal(countMatches(`npx ${clean}`, RAW_NPX_PATTERNS), 1);
  // Alle vier unscoped Namen zählen je genau einmal.
  for (const name of ['palveron', 'agent-shield', 'palveron-mcp', 'agent-shield-mcp']) {
    assert.equal(countMatches(`npx ${name} shield init`, RAW_NPX_PATTERNS), 1, name);
  }
  // Die einzige zulässige npx-Form bleibt unbeanstandet: nach `npx` kommt
  // `-p` und ein gescopter Paketname, kein unscoped Name.
  assert.equal(
    countMatches('npx -p @palveron/agent-shield palveron shield init', RAW_NPX_PATTERNS),
    0,
  );

  const files = corpusFiles(REPO_ROOT);
  assertCorpusPlausible(files);

  let rawTotal = 0;
  const violations = [];
  for (const file of files) {
    const hits = countMatches(readFileSync(file, 'utf8'), RAW_NPX_PATTERNS);
    if (hits > 0) {
      rawTotal += hits;
      violations.push(`${relative(REPO_ROOT, file)}: ${hits}× npx + unscoped Name`);
    }
  }

  console.log(
    `command-name-gate: ${files.length} Dateien geprüft, ROH-Muster npx+unscoped: ${rawTotal} (Soll 0)`,
  );
  assert.equal(
    rawTotal,
    0,
    `npx mit unscoped Paketnamen im Repositorium (Paket gehört uns nicht):\n${violations.join('\n')}`,
  );
});
