/**
 * Drop questions with date-sanity flags (Synthea birth-offset bugs).
 * Also enumerate multi-hop questions and heuristically flag any that look
 * like single-join simple-lookups.
 *
 * Usage: npx tsx scripts/drop-flagged.ts
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ROOT = join(import.meta.dirname, '..');
const FILES = [
  'data/generated/evaluation-questions-tiered.json',
  'data/generated/evaluation-questions.json',
];

type Question = {
  id: string;
  type: string;
  question: string;
  answer: string;
  flags?: string[];
  [k: string]: unknown;
};

/**
 * Heuristic: a multi-hop question requires chaining 2+ entity lookups.
 * Single-join shape (encounter → procedures, encounter → meds) masquerading
 * as multi-hop matches patterns like:
 *   "at the most recent <type> visit"
 *   "at the last <type> encounter"
 *   "for the most recent X"
 * Without an earlier join clause like "where the patient was first diagnosed".
 */
function looksSingleJoin(q: Question): boolean {
  if (q.type !== 'multi-hop') return false;
  const t = q.question.toLowerCase();
  // True multi-hop signals — chains two conditions
  const trueMultihopMarkers = [
    'where the patient was first',
    'where the patient was diagnosed',
    'where the patient was prescribed',
    'when the patient was first',
    'at the encounter where',
    'on the day',
    'within',
    'before',
    'after',
  ];
  if (trueMultihopMarkers.some((m) => t.includes(m))) return false;
  // Single-join hint — "at the most recent X" with no second join
  const singleJoinMarkers = [
    'at the most recent',
    'at the last',
    'for the most recent',
    'during the most recent',
  ];
  return singleJoinMarkers.some((m) => t.includes(m));
}

function process(path: string) {
  const full = join(PROJECT_ROOT, path);
  let raw: string;
  try { raw = readFileSync(full, 'utf-8'); } catch { return; }

  const qs = JSON.parse(raw) as Question[];
  const backup = full.replace(/\.json$/, `.dropflag-backup-${new Date().toISOString().slice(0, 10)}.json`);
  copyFileSync(full, backup);

  // Drop flagged
  const before = qs.length;
  const dropped = qs.filter((q) => q.flags && q.flags.length > 0);
  const kept = qs.filter((q) => !q.flags || q.flags.length === 0);
  for (const q of dropped) console.log(`  dropped ${q.id} (${q.type}): ${q.flags?.[0]}`);

  // Heuristic multi-hop audit
  const suspectedSingleJoin = kept.filter(looksSingleJoin);
  if (suspectedSingleJoin.length > 0) {
    console.log(`\n  heuristic flag: ${suspectedSingleJoin.length} multi-hop question(s) look like single-join lookups:`);
    for (const q of suspectedSingleJoin) {
      console.log(`    ${q.id}: ${q.question}`);
    }
  }

  writeFileSync(full, JSON.stringify(kept, null, 2));
  console.log(`\n  ${path}: ${before} → ${kept.length} (-${dropped.length})`);
}

for (const f of FILES) {
  console.log(`\n══ ${f} ══`);
  process(f);
}
