/**
 * Apply clinician-authored paraphrases from /tmp/paraphrases.json to the
 * question bank so duplicated templates become textually unique across
 * their instances.
 *
 * Each entry in paraphrases.json maps (type, original) → paraphrases[].
 * We group bank questions by (type, question), and for each group we rotate
 * through the paraphrases list assigning a fresh variant to every instance.
 *
 * Usage: npx tsx scripts/apply-paraphrases.ts
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ROOT = join(import.meta.dirname, '..');
const PARAPHRASE_FILE = '/tmp/paraphrases.json';
const FILES = [
  'data/generated/evaluation-questions-tiered.json',
  'data/generated/evaluation-questions.json',
];

type Question = {
  id: string;
  type: string;
  question: string;
  [k: string]: unknown;
};

type ParaphraseEntry = {
  type: string;
  original: string;
  paraphrases: string[];
  notes?: string;
};

const paraphrases = JSON.parse(readFileSync(PARAPHRASE_FILE, 'utf-8')) as ParaphraseEntry[];
const lookup = new Map<string, string[]>();
for (const p of paraphrases) lookup.set(`${p.type}||${p.original}`, p.paraphrases);

function process(path: string) {
  const full = join(PROJECT_ROOT, path);
  let raw: string;
  try { raw = readFileSync(full, 'utf-8'); } catch { return; }
  const qs = JSON.parse(raw) as Question[];

  const backup = full.replace(/\.json$/, `.paraphrase-backup-${new Date().toISOString().slice(0, 10)}.json`);
  copyFileSync(full, backup);

  // Group by (type, question). Iteration order over the bank determines
  // which paraphrase gets which instance — we keep order stable so reruns
  // produce identical output.
  const groupIndex = new Map<string, number>();
  let applied = 0;
  const shortages: { key: string; have: number; need: number }[] = [];

  for (const q of qs) {
    const key = `${q.type}||${q.question}`;
    const variants = lookup.get(key);
    if (!variants) continue;
    const i = groupIndex.get(key) ?? 0;
    if (i >= variants.length) {
      // Wrap around on shortage. Record it for the report.
      shortages.push({ key, have: variants.length, need: i + 1 });
      q.question = variants[i % variants.length];
    } else {
      q.question = variants[i];
    }
    groupIndex.set(key, i + 1);
    applied++;
  }

  writeFileSync(full, JSON.stringify(qs, null, 2));

  console.log(`  ${path}: applied paraphrases to ${applied} questions`);
  if (shortages.length > 0) {
    const uniq = new Set(shortages.map((s) => s.key));
    console.log(`  shortages (wrapped around): ${shortages.length} instances across ${uniq.size} template(s)`);
  }

  // Dup check
  const byType: Record<string, Record<string, number>> = {};
  for (const q of qs) {
    byType[q.type] ??= {};
    byType[q.type][q.question] = (byType[q.type][q.question] ?? 0) + 1;
  }
  let totalDupGroups = 0;
  for (const [t, counts] of Object.entries(byType)) {
    const dups = Object.values(counts).filter((n) => n > 1).length;
    totalDupGroups += dups;
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    const unique = Object.keys(counts).length;
    console.log(`    ${t.padEnd(15)} total=${total} unique=${unique}${dups > 0 ? ` (${dups} dup-groups remain)` : ''}`);
  }
  console.log(`  residual duplicate groups: ${totalDupGroups}`);
}

for (const f of FILES) {
  console.log(`\n══ ${f} ══`);
  process(f);
}
