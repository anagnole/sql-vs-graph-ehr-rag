/**
 * Final cleanup pass addressing the clinician-audit's remaining critical
 * issues:
 *   1. Social-history leakage — extend the filter from simple-lookup active-
 *      conditions to multi-hop, reasoning, and cohort answers; and drop any
 *      question whose QUESTION TEXT references a social-history "diagnosis".
 *   2. Temporal-window mismatch — questions that say "past year" / "last
 *      12 months" but whose ground truth spans multiple years. Rephrase to
 *      "over time" / "across available measurements".
 *   3. RxNorm verbosity in QUESTION TEXT (not just answers). Earlier pass
 *      only touched SL/MH answers; extend to question text across all types.
 *   4. Replace UNA-112 (education) and UNA-113 (exercise) — overlap with
 *      Synthea data we actually have.
 *
 * Usage: npx tsx scripts/final-cleanup.ts
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ROOT = join(import.meta.dirname, '..');
const FILE = 'data/generated/evaluation-questions-tiered.json';

type Question = {
  id: string;
  type: string;
  question: string;
  answer: string;
  patientIds?: string[];
  [k: string]: unknown;
};

// ─── Social-history detection ───────────────────────────────────────────────
const SOCIAL_KEYWORDS = [
  'full-time employment',
  'part-time employment',
  'unemployed',
  'not in labor force',
  'educated to',
  'received higher education',
  'higher education',
  'has a criminal record',
  'limited social contact',
  'housing unsatisfactory',
  'homeless',
  'medication review due',
  'serving in military service',
  'military service',
  'victim of',
  'social isolation',
  'reports of violence',
  'risk activity involvement',
  'awaiting transplantation of kidney',
];

function containsSocialHistory(s: string): boolean {
  const lower = s.toLowerCase();
  return SOCIAL_KEYWORDS.some((k) => lower.includes(k));
}

function filterSocialFromList(answer: string): string {
  // Handles ";" lists and "; ... (N)" cohort-ranking lists.
  if (!answer.includes(';')) return answer;
  const parts = answer.split(';').map((p) => p.trim()).filter(Boolean);
  const kept = parts.filter((p) => !containsSocialHistory(p));
  return kept.join('; ');
}

// ─── Temporal-window rephrasing ─────────────────────────────────────────────
// Replace 1-year window phrasings when the ground truth spans a longer period.
const TEMPORAL_WINDOW_REPLACEMENTS: [RegExp, string][] = [
  [/\bover the past year\b/gi, 'over time'],
  [/\bover the past 12 months\b/gi, 'over time'],
  [/\bin the last 12 months\b/gi, 'across available measurements'],
  [/\bin the past year\b/gi, 'over time'],
  [/\bover the last year\b/gi, 'across available measurements'],
  [/\bduring the past year\b/gi, 'across available measurements'],
  [/\bthroughout the past year\b/gi, 'over time'],
  [/\bin recent months\b/gi, 'across recent measurements'],
];

function rephraseTemporalWindow(question: string): string {
  let out = question;
  for (const [re, repl] of TEMPORAL_WINDOW_REPLACEMENTS) out = out.replace(re, repl);
  return out;
}

// Determine if a temporal GT answer spans > 18 months (i.e. the "past year"
// phrasing would be misleading). If yes, rephrase.
function gtSpansMoreThanYear(answer: string): boolean {
  const dates = [...answer.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)].map((m) => ({
    year: parseInt(m[1]),
    month: parseInt(m[2]),
    day: parseInt(m[3]),
  }));
  if (dates.length < 2) return false;
  const ts = dates.map((d) => new Date(d.year, d.month - 1, d.day).getTime());
  const span = Math.max(...ts) - Math.min(...ts);
  return span > 1.5 * 365 * 24 * 3600 * 1000;
}

// ─── RxNorm in question text ────────────────────────────────────────────────
const RXNORM_IN_QUESTION: [RegExp, string][] = [
  [/\bOral Tablet\b/gi, ''],
  [/\bOral Capsule\b/gi, 'capsule'],
  [/\bExtended Release\b/gi, 'ER'],
  [/\b12 HR\b/gi, ''],
  [/\b24 HR\b/gi, ''],
  [/\bInjectable Suspension\b/gi, 'injectable'],
  [/\bInjectable Solution\b/gi, 'injection'],
  [/\bMetered Dose Inhaler\b/gi, 'MDI'],
  [/\bOral Solution\b/gi, 'solution'],
  [/\bACTUAT\b/gi, 'actuation'],
  [/\bUNT\/ML\b/gi, 'unt/mL'],
  [/\s*\[[A-Za-z][^\]]*\]/g, ''],  // brand-name brackets anywhere
  [/\b(MG|MCG|MEQ|UNT)\b/g, (m: string) => m.toLowerCase()],
  [/\s{2,}/g, ' '],
];

function normalizeRxNormInText(s: string): string {
  let out = s;
  for (const [re, repl] of RXNORM_IN_QUESTION) {
    out = typeof repl === 'string' ? out.replace(re, repl) : out.replace(re, repl as (m: string) => string);
  }
  // Collapse double spaces and any whitespace that ended up immediately
  // before sentence-ending punctuation (e.g. "Acetaminophen 325 mg ?").
  return out.replace(/\s+/g, ' ').replace(/\s+([?.!,;])/g, '$1').trim();
}

// ─── UNA-112 / UNA-113 replacements ─────────────────────────────────────────
const UNA_REPLACEMENTS: Record<string, { question: string; answer: string }> = {
  'UNA-112': {
    question: `Who is listed as the patient's emergency contact?`,
    answer: `UNANSWERABLE: Emergency contact information is not captured in this EHR system.`,
  },
  'UNA-113': {
    question: `What is the patient's preferred pharmacy location?`,
    answer: `UNANSWERABLE: Preferred pharmacy information is not captured in this EHR system.`,
  },
};

// ─── Main processing ────────────────────────────────────────────────────────

function process() {
  const full = join(PROJECT_ROOT, FILE);
  const raw = readFileSync(full, 'utf-8');
  const qs = JSON.parse(raw) as Question[];

  const backup = full.replace(/\.json$/, `.final-backup-${new Date().toISOString().slice(0, 10)}.json`);
  copyFileSync(full, backup);

  const report = {
    answerSocialFiltered: 0,
    questionDroppedForSocial: 0,
    temporalRephrased: 0,
    rxnormNormalizedInQuestion: 0,
    unaReplaced: 0,
  };

  const dropped: Question[] = [];
  const kept: Question[] = [];

  for (const q of qs) {
    // (1a) Drop questions whose text itself references social-history as
    // if it were a clinical diagnosis. These are generator artefacts; the
    // agent can't answer correctly and the scorer can't score correctly.
    const questionMentionsSocialAsDiagnosis =
      (q.type === 'multi-hop' || q.type === 'temporal' || q.type === 'reasoning') &&
      /diagnosed(?:\s+(?:the\s+patient|the\s+person|them))?\s+with\s+.*(employment|higher education|educated to|criminal record|medication review due|military service)/i.test(
        q.question,
      );
    if (questionMentionsSocialAsDiagnosis) {
      dropped.push(q);
      report.questionDroppedForSocial++;
      continue;
    }

    // (1b) Filter social-history entries out of list-style answers for
    // all types (not just simple-lookup).
    if (typeof q.answer === 'string' && q.answer.includes(';')) {
      const filtered = filterSocialFromList(q.answer);
      if (filtered !== q.answer) {
        q.answer = filtered;
        report.answerSocialFiltered++;
      }
    }

    // (2) Temporal-window rephrasing when GT spans > 1.5 years
    if (q.type === 'temporal' && gtSpansMoreThanYear(q.answer)) {
      const rephrased = rephraseTemporalWindow(q.question);
      if (rephrased !== q.question) {
        q.question = rephrased;
        report.temporalRephrased++;
      }
    }

    // (3) RxNorm normalization in question text — applies to any question
    // that embeds a medication description with verbose RxNorm tokens.
    if (/(Oral Tablet|Oral Capsule|Extended Release|Injectable Suspension|ACTUAT|UNT\/ML|\[[A-Za-z]+\]|\b(12|24) HR\b)/i.test(q.question)) {
      const normalized = normalizeRxNormInText(q.question);
      if (normalized !== q.question) {
        q.question = normalized;
        report.rxnormNormalizedInQuestion++;
      }
    }

    // (4) UNA-112 / UNA-113 replacements
    const rep = UNA_REPLACEMENTS[q.id];
    if (rep) {
      q.question = rep.question;
      q.answer = rep.answer;
      report.unaReplaced++;
    }

    kept.push(q);
  }

  writeFileSync(full, JSON.stringify(kept, null, 2));

  console.log('Final cleanup report:');
  console.log(`  list-answers social-filtered    : ${report.answerSocialFiltered}`);
  console.log(`  questions dropped (social-as-dx): ${report.questionDroppedForSocial}`);
  for (const d of dropped.slice(0, 5)) console.log(`    - ${d.id}: ${d.question.slice(0, 90)}`);
  console.log(`  temporal window rephrased       : ${report.temporalRephrased}`);
  console.log(`  RxNorm normalized in question   : ${report.rxnormNormalizedInQuestion}`);
  console.log(`  UNA replaced                    : ${report.unaReplaced}`);
  console.log(`  final size: ${qs.length} → ${kept.length}`);

  const byType: Record<string, number> = {};
  for (const q of kept) byType[q.type] = (byType[q.type] ?? 0) + 1;
  for (const [t, n] of Object.entries(byType)) console.log(`    ${t.padEnd(15)} ${n}`);
}

process();
