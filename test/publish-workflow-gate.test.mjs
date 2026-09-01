// test/publish-workflow-gate.test.mjs
// GOAL Veröffentlichungsweg agent-shield (01.09.2026) — Wächter über den
// Auslöser der Veröffentlichungs-Ablaufdatei. Läuft im normalen `npm test`
// (node --test) mit — kein eigenes Skript, kein Auslöser, der vergessen wird.
//
// Was es prüft, wogegen es misst: Es liest `.github/workflows/publish.yml`
// und führt ZWEI Zahlen —
//   (1) Treffer für `push:`, `workflow_dispatch:`, `schedule:` auf der
//       obersten Auslöserebene (im `on:`-Block): Soll 0. Ein
//       Veröffentlichungsweg, der bei einem Push feuern könnte, ist ein
//       Risiko, keine Bequemlichkeit.
//   (2) Vorkommen der erwarteten Bestandteile — `release`, `published`,
//       `id-token: write`, `npm ci`, `npm test`, `npm publish` mit
//       `--provenance`: Soll größer 0.
// Zwei Zahlen, weil eine allein nichts entscheidet: Fehlte die Datei ganz,
// wären beide null, und die erste Prüfung allein sähe wie ein guter Befund
// aus.
//
// Was ein Verstoß bedeutet: Der Release-Weg könnte ungewollt (per Push oder
// Hand-Auslösung) feuern, ohne Provenienz veröffentlichen oder ohne Test
// veröffentlichen — jede dieser Formen wäre eine stille Schwächung des
// Veröffentlichungswegs eines Sicherheitswerkzeugs.
//
// Ehrliche Grenze: Dieses Gate misst die DATEI, nicht das Verhalten von
// GitHub. Es beweist, dass der Auslöser so dasteht — nicht, dass kein Ablauf
// startet. Der Beleg dafür ist eine Sichtprüfung des Architekten nach dem
// Push (Actions-Ansicht: kein Lauf ohne Release).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.github',
  'workflows',
  'publish.yml',
);

/** Schneidet den obersten `on:`-Block heraus (bis zur nächsten Zeile ohne
 *  Einrückung) und zählt dort verbotene Auslöser. */
export function forbiddenTriggerHits(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const start = lines.findIndex((l) => /^on:\s*$/.test(l) || /^on:\s+\S/.test(l));
  if (start === -1) return { hits: -1, block: '' }; // kein on:-Block — eigener Fehlerfall
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '' && !/^\s/.test(lines[i])) break;
    block.push(lines[i]);
  }
  const text = block.join('\n');
  // Inline-Form: `[ \t]*`, nicht `\s*` — `\s` träfe den Zeilenumbruch und
  // machte aus `on:` + Folgezeile `push:` einen doppelt gezählten Treffer.
  const hits = (text.match(/^\s*(push|workflow_dispatch|schedule):/gm) ?? []).length
    + (text.match(/^on:[ \t]*(push|workflow_dispatch|schedule)\b/m) ? 1 : 0);
  return { hits, block: text };
}

const EXPECTED_PARTS = [
  'release',
  'published',
  'id-token: write',
  'npm ci',
  'npm test',
  'npm publish',
  '--provenance',
];

test('publish.yml fires only on release:published and carries the expected steps', () => {
  // Positive Kontrollproben: die Zähler MÜSSEN synthetische Verletzungen
  // treffen — ein Muster, das die eigene Probe verfehlt, misst nichts.
  const probe = 'on:\n  push:\n    branches: [master]\n  release:\n    types: [published]\njobs:\n';
  assert.equal(forbiddenTriggerHits(probe).hits, 1, 'Kontrollprobe: push:-Auslöser muss zählen');
  assert.equal(forbiddenTriggerHits('on: push\njobs:\n').hits, 1, 'Kontrollprobe: Inline-Form');
  assert.equal(forbiddenTriggerHits('on:\n  release:\n    types: [published]\n').hits, 0);

  const yaml = readFileSync(WORKFLOW, 'utf8');

  const { hits, block } = forbiddenTriggerHits(yaml);
  assert.notEqual(hits, -1, 'publish.yml hat keinen on:-Block — Gate kann nicht messen');

  const present = EXPECTED_PARTS.filter((p) => yaml.includes(p));
  const missing = EXPECTED_PARTS.filter((p) => !yaml.includes(p));

  console.log(
    `publish-workflow-gate: verbotene Auslöser im on:-Block: ${hits} (Soll 0), ` +
      `erwartete Bestandteile: ${present.length}/${EXPECTED_PARTS.length} (Soll > 0)`,
  );

  assert.ok(
    present.length > 0,
    'Kein erwarteter Bestandteil gefunden — Datei leer oder Gate misst nichts',
  );
  assert.deepEqual(
    missing,
    [],
    `publish.yml fehlen erwartete Bestandteile: ${missing.join(', ')}`,
  );
  assert.equal(
    hits,
    0,
    `Verbotener Auslöser auf oberster Ebene des on:-Blocks von publish.yml:\n${block}`,
  );
});
