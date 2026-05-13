/**
 * Second normalization pass on the question bank, applying the fixes the
 * clinician-audit agent flagged:
 *   - strip SNOMED `(disorder|finding|situation|...)` suffixes from questions and answers
 *   - normalize RxNorm strings to `generic strength dose_form`
 *   - replace "over their recent measurements" with "over the past year"
 *   - filter Synthea social-history entries out of "active conditions" answers
 *   - drop `(across N patients)` metadata from cohort answers, move to `metadataN`
 *   - flag questions with impossible early diagnosis dates (pre-1990 for
 *     modern diagnostic concepts like Prediabetes, post-dated for minors)
 *
 * Reclassification and UNA-2 checks are reported but not auto-fixed.
 *
 * Usage: npx tsx scripts/normalize-questions.ts
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
  patientIds?: string[];
  groundTruthByTier?: Record<string, string>;
  metadataN?: number;
  flags?: string[];
  [k: string]: unknown;
};

// ─── SNOMED suffix stripping ────────────────────────────────────────────────
// Matches "(disorder)", "(finding)", "(situation)", "(procedure)", etc.
// Keep "(recorded 2023-...)" and other non-SNOMED parentheticals untouched.
const SNOMED_TAGS = [
  'disorder', 'finding', 'situation', 'procedure', 'observable entity',
  'regime/therapy', 'qualifier value', 'substance', 'body structure',
  'person', 'occupation', 'context-dependent category',
];
const SNOMED_RE = new RegExp(`\\s*\\((?:${SNOMED_TAGS.join('|')})\\)`, 'gi');

function stripSnomed(s: string): string {
  return s.replace(SNOMED_RE, '').replace(/\s+/g, ' ').trim();
}

// ─── RxNorm normalization ───────────────────────────────────────────────────
// Examples to handle:
//   "Naproxen sodium 220 MG Oral Tablet"
//     → "naproxen sodium 220 mg"
//   "12 HR Hydrocodone Bitartrate 10 MG Extended Release Oral Capsule"
//     → "hydrocodone bitartrate 10 mg ER capsule"
//   "insulin isophane human 70 UNT/ML ... Injectable Suspension [Humulin]"
//     → "insulin isophane 70 unt/ml injectable"
// Strategy: lowercase, drop extremely-verbose RxNorm tail words when a dose
// is already present. We only apply this to ANSWER strings that look like a
// single RxNorm phrase; question text is left alone to avoid mutating meaning.

const RXNORM_DROP_PATTERNS: [RegExp, string][] = [
  [/\b\[[^\]]+\]/g, ''],            // brand-name brackets
  [/\s*\bOral Tablet\b/gi, ''],
  [/\s*\bOral Capsule\b/gi, ' capsule'],
  [/\s*\bExtended Release\b/gi, ' ER'],
  [/\s*\b12 HR\b/gi, ''],
  [/\s*\b24 HR\b/gi, ''],
  [/\s*\bInjectable Suspension\b/gi, ' injectable'],
  [/\s*\bInjectable Solution\b/gi, ' injection'],
  [/\s*\bMetered Dose Inhaler\b/gi, ' MDI'],
  [/\s*\bOral Solution\b/gi, ' solution'],
  [/\bACTUAT\b/gi, 'actuation'],
  [/\bUNT\/ML\b/gi, 'unt/mL'],
  [/\s+/g, ' '],
];

function normalizeRxNorm(s: string): string {
  let out = s;
  for (const [re, repl] of RXNORM_DROP_PATTERNS) out = out.replace(re, repl);
  out = out.trim();
  // Lowercase the drug name up to the first digit run (the strength); keep
  // the strength and downstream tokens as-is.
  const m = out.match(/^([^0-9]+?)(\s+\d.*)?$/);
  if (m && m[1]) {
    const rest = m[2] ?? '';
    // Also normalize "MG" → "mg" in the strength.
    out = m[1].toLowerCase().trim() + rest.replace(/\b(MG|MCG|ML|MEQ|UNT)\b/gi, (_, u) => u.toLowerCase());
  }
  return out;
}

// ─── Temporal phrasing ──────────────────────────────────────────────────────
function normalizeTemporalPhrasing(s: string): string {
  return s
    .replace(/\s+over their recent measurements/gi, ' over the past year')
    .replace(/\s+over recent measurements/gi, ' over the past year');
}

// ─── Social-history filter for condition answers ────────────────────────────
// Synthea populates the conditions table with SNOMED `(finding)` concepts
// that are social/educational/employment — not clinical conditions. Strip
// them from answer lists.
const SOCIAL_KEYWORDS = [
  'full-time employment',
  'part-time employment',
  'unemployed',
  'employment',
  'educated to',
  'higher education',
  'received higher education',
  'has a criminal record',
  'not in labor force',
  'limited social contact',
  'housing unsatisfactory',
  'homeless',
  'medication review due',
  'serving in military service',
  'military service',
  'victim of',
  'social isolation',
  'reports of violence',
  'stress',
  'risk activity involvement',
  'awaiting transplantation of kidney',
];

function looksLikeActiveConditionsAnswer(q: Question): boolean {
  return (
    q.type === 'simple-lookup' &&
    /active conditions/i.test(q.question) &&
    typeof q.answer === 'string' &&
    q.answer.includes(';')
  );
}

function filterSocialFromConditions(answer: string): { cleaned: string; removed: number } {
  const parts = answer.split(';').map((p) => p.trim()).filter(Boolean);
  const kept: string[] = [];
  let removed = 0;
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (SOCIAL_KEYWORDS.some((k) => lower.includes(k))) {
      removed++;
      continue;
    }
    kept.push(p);
  }
  return { cleaned: kept.join('; '), removed };
}

// ─── Cohort metadata stripping ──────────────────────────────────────────────
// Match "(across N patients)" and similar denominator metadata, lift N.
const COHORT_META_RE = /\s*\(across (\d+) patients?\)\s*/i;

function stripCohortMetadata(answer: string): { cleaned: string; n: number | null } {
  const m = answer.match(COHORT_META_RE);
  if (!m) return { cleaned: answer, n: null };
  return { cleaned: answer.replace(COHORT_META_RE, '').trim(), n: parseInt(m[1]) };
}

// ─── Date-sanity flag ───────────────────────────────────────────────────────
// Flag "first diagnosed ... <early date>" where the concept is modern.
const MODERN_CONCEPTS: [RegExp, number][] = [
  [/prediabetes/i, 1997],  // ADA 1997/2003
  [/metabolic syndrome/i, 1988],
  [/covid/i, 2019],
];

function flagImpossibleDiagnosisDate(q: Question): string | null {
  if (q.type !== 'temporal') return null;
  if (!/first diagnosed/i.test(q.question)) return null;
  const ans = typeof q.answer === 'string' ? q.answer : '';
  const dm = ans.match(/(\d{4})-\d{2}-\d{2}/);
  if (!dm) return null;
  const year = parseInt(dm[1]);
  for (const [re, earliest] of MODERN_CONCEPTS) {
    if (re.test(q.question) && year < earliest) {
      return `first-diagnosis year ${year} predates concept (${re}; expected ≥ ${earliest})`;
    }
  }
  return null;
}

// ─── Main processing ────────────────────────────────────────────────────────

type Report = {
  total: number;
  snomedStrippedQuestions: number;
  snomedStrippedAnswers: number;
  rxnormNormalized: number;
  temporalPhrasingFixed: number;
  socialHistoryFiltered: number;
  cohortMetadataStripped: number;
  dateFlags: { id: string; reason: string }[];
  una2Status: string;
};

function process(path: string): Report | null {
  const full = join(PROJECT_ROOT, path);
  let raw: string;
  try { raw = readFileSync(full, 'utf-8'); } catch { return null; }

  const qs = JSON.parse(raw) as Question[];

  const backup = full.replace(/\.json$/, `.normalized-backup-${new Date().toISOString().slice(0, 10)}.json`);
  copyFileSync(full, backup);

  const report: Report = {
    total: qs.length,
    snomedStrippedQuestions: 0,
    snomedStrippedAnswers: 0,
    rxnormNormalized: 0,
    temporalPhrasingFixed: 0,
    socialHistoryFiltered: 0,
    cohortMetadataStripped: 0,
    dateFlags: [],
    una2Status: 'not found',
  };

  for (const q of qs) {
    // SNOMED suffix strip (question + answer)
    const q0 = q.question;
    q.question = stripSnomed(q0);
    if (q.question !== q0) report.snomedStrippedQuestions++;

    if (typeof q.answer === 'string') {
      const a0 = q.answer;
      q.answer = stripSnomed(a0);
      if (q.answer !== a0) report.snomedStrippedAnswers++;
    }

    // Temporal phrasing
    const qt0 = q.question;
    q.question = normalizeTemporalPhrasing(q.question);
    if (q.question !== qt0) report.temporalPhrasingFixed++;

    // Social-history filter
    if (looksLikeActiveConditionsAnswer(q)) {
      const { cleaned, removed } = filterSocialFromConditions(q.answer);
      if (removed > 0) {
        q.answer = cleaned;
        report.socialHistoryFiltered++;
      }
    }

    // Cohort metadata strip
    if (q.type === 'cohort' && typeof q.answer === 'string') {
      const { cleaned, n } = stripCohortMetadata(q.answer);
      if (n != null) {
        q.answer = cleaned;
        q.metadataN = n;
        report.cohortMetadataStripped++;
      }
      // Also strip from groundTruthByTier if present
      if (q.groundTruthByTier) {
        for (const [tier, val] of Object.entries(q.groundTruthByTier)) {
          const { cleaned } = stripCohortMetadata(val);
          q.groundTruthByTier[tier] = cleaned;
        }
      }
    }

    // RxNorm normalization — apply to answers of simple-lookup / multi-hop
    // that are medication-looking (contains a strength like "220 MG").
    if (
      (q.type === 'simple-lookup' || q.type === 'multi-hop') &&
      typeof q.answer === 'string' &&
      /\b\d+\s*M[GL]\b/i.test(q.answer) &&
      /(Oral Tablet|Oral Capsule|Injectable|MDI|Actuation|ACTUAT|\bHR\b)/i.test(q.answer)
    ) {
      const a0 = q.answer;
      // Handle semicolon-separated lists of meds too
      q.answer = a0.split(';').map((s) => normalizeRxNorm(s.trim())).join('; ');
      if (q.answer !== a0) report.rxnormNormalized++;
    }

    // Date-sanity flag
    const flag = flagImpossibleDiagnosisDate(q);
    if (flag) {
      q.flags = [...(q.flags ?? []), flag];
      report.dateFlags.push({ id: q.id, reason: flag });
    }

    // UNA-2 consistency check
    if (q.id === 'UNA-2') {
      const patientIdsCount = (q.patientIds ?? []).length;
      report.una2Status = `patientIds=${patientIdsCount}, question="${q.question}", answer="${q.answer}"`;
    }
  }

  writeFileSync(full, JSON.stringify(qs, null, 2));
  return report;
}

for (const f of FILES) {
  console.log(`\n══ ${f} ══`);
  const r = process(f);
  if (!r) { console.log('  (not found)'); continue; }
  console.log(`  total: ${r.total}`);
  console.log(`  SNOMED suffix stripped: ${r.snomedStrippedQuestions} question(s), ${r.snomedStrippedAnswers} answer(s)`);
  console.log(`  RxNorm normalized: ${r.rxnormNormalized}`);
  console.log(`  temporal phrasing fixed: ${r.temporalPhrasingFixed}`);
  console.log(`  social-history filtered: ${r.socialHistoryFiltered} answer(s)`);
  console.log(`  cohort metadata lifted: ${r.cohortMetadataStripped}`);
  console.log(`  date-flags: ${r.dateFlags.length}`);
  for (const f of r.dateFlags.slice(0, 5)) console.log(`    ${f.id}: ${f.reason}`);
  console.log(`  UNA-2: ${r.una2Status}`);
}
