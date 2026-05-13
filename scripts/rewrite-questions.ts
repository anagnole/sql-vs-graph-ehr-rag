/**
 * Rewrite the question bank to contextual patient scoping, matching the style
 * of EHRSQL / emrQA / FHIR-AgentBench (no inline names, no inline UUIDs).
 *
 * Transforms:
 *   "What is the trend in Systolic Blood Pressure values for patient
 *    Bradly656 Fay398 (ID: 000085c1-...) over their recent measurements?"
 * →
 *   "What is the trend in Systolic Blood Pressure values for the patient
 *    over their recent measurements?"
 *
 * For sentinel "patient-not-found" unanswerable questions where the fake
 * UUID lives only in the question text, we also lift the UUID into the
 * patientIds[] field so the harness can pass it as context and the
 * downstream retrieval still fails (the point of those questions).
 *
 * Usage: npx tsx scripts/rewrite-questions.ts
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ROOT = join(import.meta.dirname, '..');
const FILES = [
  'data/generated/evaluation-questions-tiered.json',
  'data/generated/evaluation-questions.json',
];

// Matches:  [optional "patient "]  [Name Token]+ [whitespace]  (ID: uuid)
// - "patient " prefix is optional — some questions use bare names
//   ("where Mia349 O'Reilly797 (ID: ...)")
// - Name tokens allow Unicode letters (Sánchez), digits (Juan88), apostrophes
// - UUID is any lowercase hex-dash sequence
const PATIENT_RE =
  /(?:patient\s+)?(\p{Lu}[\p{L}0-9']*(?:\s+\p{Lu}[\p{L}0-9']*)+)\s*\(ID:\s*([a-f0-9-]+)\)/u;

type Question = {
  id: string;
  type: string;
  question: string;
  answer: string;
  patientIds?: string[];
  [k: string]: unknown;
};

function rewriteOne(q: Question): { changed: boolean; rewrittenText: string; extractedId: string | null } {
  const m = q.question.match(PATIENT_RE);
  if (!m) return { changed: false, rewrittenText: q.question, extractedId: null };

  const extractedId = m[2];
  // Replace the matched run with "the patient" — preserves whatever came
  // before ("for ", "where ", "of ", etc.) and after.
  const rewritten = q.question.replace(PATIENT_RE, 'the patient');
  return { changed: true, rewrittenText: rewritten, extractedId };
}

function process(path: string) {
  const full = join(PROJECT_ROOT, path);
  let raw: string;
  try {
    raw = readFileSync(full, 'utf-8');
  } catch {
    console.log(`  skip: ${path} (not found)`);
    return;
  }
  const qs = JSON.parse(raw) as Question[];

  // Backup original
  const backup = full.replace(/\.json$/, `.backup-${new Date().toISOString().slice(0, 10)}.json`);
  copyFileSync(full, backup);

  let changedCount = 0;
  let liftedIdCount = 0;
  const unchanged: Question[] = [];
  for (const q of qs) {
    const { changed, rewrittenText, extractedId } = rewriteOne(q);
    if (changed) {
      q.question = rewrittenText;
      changedCount++;
      // Lift the fake UUID into patientIds for sentinel "patient-not-found"
      // unanswerable questions where patientIds is currently empty.
      if (extractedId && (!q.patientIds || q.patientIds.length === 0)) {
        q.patientIds = [extractedId];
        liftedIdCount++;
      }
    } else {
      unchanged.push(q);
    }
  }

  writeFileSync(full, JSON.stringify(qs, null, 2));
  console.log(`  ${path}: rewrote ${changedCount}/${qs.length} questions, lifted ${liftedIdCount} sentinel IDs, backup → ${backup.split('/').pop()}`);

  // Flag any unchanged patient-specific questions for manual review
  const suspicious = unchanged.filter(
    (q) =>
      q.type !== 'cohort' &&
      !(q.type === 'unanswerable' && (q.patientIds ?? []).length === 0 && !q.question.toLowerCase().includes('patient')) &&
      /\(ID:/i.test(q.question),
  );
  if (suspicious.length > 0) {
    console.log(`  WARN: ${suspicious.length} patient-specific questions still contain "(ID:" — regex missed them:`);
    for (const q of suspicious.slice(0, 5)) console.log(`    ${q.id}: ${q.question.slice(0, 120)}`);
  }
}

for (const f of FILES) process(f);
console.log('\nDone. Run scorer tests and eyeball sample before re-running evals.');
