// test/command-name-gate.test.mjs
// GOAL "Ein Befehl: palveron shield" (01.09.2026) — Wächter gegen das
// Wiederauftauchen des alten Befehlsnamens. Läuft im normalen `npm test`
// (node --test) mit — kein eigenes Skript, kein Auslöser, der vergessen wird.
//
// Was es prüft: Jede Textfläche dieses Repositoriums (Dateisystem-Scan mit
// den dokumentierten Ausschlüssen unten) trägt
//   (1) NULL Treffer des ALTEN Befehlsmusters — `agent-shield init|status|
//       test|help` als Kommando sowie `agent-shield-mcp` als ausführbarer
//       Name — und
//   (2) mehr als null Treffer des NEUEN Musters (`palveron shield` als
//       Kommando bzw. als npx-args-Folge `'palveron', 'shield'`).
// Sind beide Zahlen null, hat das Gate nichts gemessen und schlägt fehl.
//
// Was ein Verstoß bedeutet: Eine Fläche (Code, Hilfe, README, SKILL, Test)
// bewirbt oder startet wieder den alten Namen — ein Kunde bekäme ein
// Kommando gezeigt, das das Paket nicht mehr trägt. Das Paket wurde vor der
// ersten Veröffentlichung umbenannt; es gibt bewusst keinen Alias.
//
// Ausschlüsse, je begründet:
//   node_modules/, .git/  — fremder bzw. generierter Bestand
//   .debug/               — gitignorierte Laufzeit-/Nachweisreste (das
//                           historische harness.mjs trägt den Altnamen)
//   package-lock.json     — gitignoriert, von npm generiert
//   .env.smoke            — gitignorierte lokale Konfiguration
//   test/command-name-gate.test.mjs — dieses Gate selbst (trägt die alten
//                           Muster als Messsonden)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.debug']);
const EXCLUDED_FILES = new Set([
  'package-lock.json',
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

test('the old command name is gone and the new one is present (two numbers)', () => {
  // Positive Kontrollproben: jedes Muster MUSS seine synthetische Verletzung
  // treffen — ein Muster, das die eigene Probe verfehlt, misst nichts.
  assert.equal(countMatches('run agent-shield init now', [OLD_PATTERNS[0]]), 1);
  assert.equal(countMatches('spawns agent-shield-mcp', [OLD_PATTERNS[1]]), 1);
  assert.equal(countMatches('npx palveron shield init', [NEW_PATTERNS[0]]), 1);
  assert.equal(countMatches(`args: ['palveron', 'shield', 'mcp']`, [NEW_PATTERNS[1]]), 1);

  const files = corpusFiles(REPO_ROOT);
  assert.ok(
    files.length > 15,
    `Korpus verdächtig klein (${files.length} Dateien) — Scan defekt?`,
  );

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
