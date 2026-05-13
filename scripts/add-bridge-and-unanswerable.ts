/**
 * Additions to the question bank:
 *   1. 15 SM3-style comparability-bridge questions — schema-attribute-oriented
 *      reformulations of existing simple-lookup items (same patient, same
 *      answer, SM3-style phrasing). Tagged `sm3Bridge: true`.
 *   2. 14 new unanswerable questions split 7/7 between:
 *        - medical (clinical questions outside EHR data scope)
 *        - non-medical (non-clinical attributes — SM3's other bucket)
 *
 * This brings unanswerable from 14 → 28, matching the paper's target.
 *
 * Usage: npx tsx scripts/add-bridge-and-unanswerable.ts
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
  domain?: string;
  sm3Bridge?: boolean;
  sm3SourceId?: string;
  unanswerableKind?: 'medical' | 'non-medical';
  [k: string]: unknown;
};

// ─── Bridge reformulation templates ─────────────────────────────────────────
// Each takes an existing simple-lookup question + its answer and returns an
// SM3-style schema-attribute-oriented reformulation.

type BridgeRule = {
  match: (q: Question) => boolean;
  rewrite: (q: Question) => string;
};

const bridgeRules: BridgeRule[] = [
  {
    match: (q) => /most recent (total cholesterol|creatinine|hemoglobin a1c|urea nitrogen)/i.test(q.question),
    rewrite: (q) => {
      const labMatch = q.question.match(/most recent ([A-Za-z][A-Za-z0-9\s]+?) (value|level|result)/i);
      const lab = labMatch?.[1]?.trim() ?? 'lab';
      return `What is the value of the most recent observation of ${lab} for the patient?`;
    },
  },
  {
    match: (q) => /active conditions/i.test(q.question) || /current active conditions/i.test(q.question) || /active problem list/i.test(q.question),
    rewrite: () =>
      `List the descriptions of all conditions with no stop_date for the patient.`,
  },
  {
    match: (q) => /demographics/i.test(q.question),
    rewrite: () =>
      `What are the birth date, gender, race, and city of residence for the patient?`,
  },
  {
    match: (q) => /currently taking|currently on|currently prescribed|active medications/i.test(q.question),
    rewrite: () =>
      `List the descriptions of all medications with no stop_date for the patient.`,
  },
  {
    match: (q) => /primary care provider|primary-care provider|pcp/i.test(q.question),
    rewrite: () =>
      `What is the name of the provider associated with the patient's most recent encounter?`,
  },
];

// ─── Unanswerable pool (medical) ────────────────────────────────────────────
// Clinical questions that a clinician would ask but our EHR cannot answer —
// modelled on SM3's `unanswerable_medical` category.
const UNA_MEDICAL: { question: string; answer: string }[] = [
  {
    question: `What are the potential drug-drug interactions between the patient's current medications?`,
    answer: `UNANSWERABLE: Drug interaction data is not available in this EHR system.`,
  },
  {
    question: `What is the 5-year survival probability for the patient given their current diagnoses?`,
    answer: `UNANSWERABLE: Survival probability modeling is not available in this EHR system.`,
  },
  {
    question: `What are the most common side effects reported for the patient's current medications?`,
    answer: `UNANSWERABLE: Medication side-effect data is not available in this EHR system.`,
  },
  {
    question: `What clinical guideline version was applied to the patient's hypertension management?`,
    answer: `UNANSWERABLE: Clinical guideline versioning metadata is not recorded in this EHR system.`,
  },
  {
    question: `What is the expected disease progression timeline for the patient's primary condition?`,
    answer: `UNANSWERABLE: Disease progression prediction is not available in this EHR system.`,
  },
  {
    question: `What is the standard-of-care treatment recommendation for the patient's current diagnoses?`,
    answer: `UNANSWERABLE: Treatment recommendation logic is not part of this EHR system.`,
  },
  {
    question: `What was the patient's pre-admission functional status before their most recent hospitalization?`,
    answer: `UNANSWERABLE: Functional status assessments are not recorded in this EHR system.`,
  },
];

// ─── Unanswerable pool (non-medical) ────────────────────────────────────────
// Non-clinical questions — modelled on SM3's `unanswerable_non_medical`
// category. Most of these are answerable in principle but not from an EHR.
const UNA_NONMEDICAL: { question: string; answer: string }[] = [
  {
    question: `What is the patient's religion?`,
    answer: `UNANSWERABLE: Religion is not captured in this EHR system.`,
  },
  {
    question: `What is the patient's annual household income?`,
    answer: `UNANSWERABLE: Household income is not captured in this EHR system.`,
  },
  {
    question: `Does the patient have any pets at home?`,
    answer: `UNANSWERABLE: Information about the patient's pets is not captured in this EHR system.`,
  },
  {
    question: `What is the patient's preferred language for communication?`,
    answer: `UNANSWERABLE: Preferred-language information is not captured in this EHR system.`,
  },
  {
    question: `What political party does the patient support?`,
    answer: `UNANSWERABLE: Political affiliation is not captured in this EHR system.`,
  },
  {
    question: `What is the patient's highest level of formal education?`,
    answer: `UNANSWERABLE: Educational attainment is not recorded in this EHR system.`,
  },
  {
    question: `What types of exercise does the patient prefer?`,
    answer: `UNANSWERABLE: Exercise preference is not captured in this EHR system.`,
  },
];

// ─── Main processing ────────────────────────────────────────────────────────

function process() {
  const full = join(PROJECT_ROOT, FILE);
  const raw = readFileSync(full, 'utf-8');
  const qs = JSON.parse(raw) as Question[];

  const backup = full.replace(/\.json$/, `.bridge-backup-${new Date().toISOString().slice(0, 10)}.json`);
  copyFileSync(full, backup);

  // ─ Generate bridge questions: 3 per rule, balanced across concepts ──────
  const simpleLookups = qs.filter((q) => q.type === 'simple-lookup');
  const bridge: Question[] = [];
  let nextBridgeIdx = 1;
  for (const rule of bridgeRules) {
    const matches = simpleLookups.filter(rule.match);
    // Take 3 (or fewer) diverse instances (different patients)
    const seenPatients = new Set<string>();
    const chosen: Question[] = [];
    for (const q of matches) {
      const pid = q.patientIds?.[0];
      if (!pid || seenPatients.has(pid)) continue;
      seenPatients.add(pid);
      chosen.push(q);
      if (chosen.length >= 3) break;
    }
    for (const src of chosen) {
      const id = `SL-BRIDGE-${nextBridgeIdx++}`;
      bridge.push({
        id,
        type: 'simple-lookup',
        question: rule.rewrite(src),
        answer: src.answer,
        patientIds: src.patientIds ? [...src.patientIds] : [],
        domain: typeof src.domain === 'string' ? src.domain : 'bridge',
        sm3Bridge: true,
        sm3SourceId: src.id,
      });
    }
  }

  // ─ Generate unanswerable additions: pair with random real patients ──────
  // Pick patients from existing patient-specific questions to avoid needing
  // a fresh patient source. Cycle through them for variety.
  const patientPool: string[] = [];
  const seen = new Set<string>();
  for (const q of qs) {
    const pid = q.patientIds?.[0];
    if (!pid) continue;
    if (seen.has(pid)) continue;
    seen.add(pid);
    patientPool.push(pid);
  }

  const unanswerableAdds: Question[] = [];
  let nextUnaIdx = 100;
  let poolIdx = 0;
  for (const src of UNA_MEDICAL) {
    unanswerableAdds.push({
      id: `UNA-${nextUnaIdx++}`,
      type: 'unanswerable',
      question: src.question,
      answer: src.answer,
      patientIds: [patientPool[poolIdx++ % patientPool.length]],
      domain: 'unanswerable-medical',
      unanswerableKind: 'medical',
    });
  }
  for (const src of UNA_NONMEDICAL) {
    unanswerableAdds.push({
      id: `UNA-${nextUnaIdx++}`,
      type: 'unanswerable',
      question: src.question,
      answer: src.answer,
      patientIds: [patientPool[poolIdx++ % patientPool.length]],
      domain: 'unanswerable-non-medical',
      unanswerableKind: 'non-medical',
    });
  }

  const updated = [...qs, ...bridge, ...unanswerableAdds];
  writeFileSync(full, JSON.stringify(updated, null, 2));

  console.log(`  bridge questions added: ${bridge.length}`);
  for (const b of bridge) {
    console.log(`    ${b.id} (from ${b.sm3SourceId}): ${b.question}`);
  }
  console.log(`\n  unanswerable questions added: ${unanswerableAdds.length} (${UNA_MEDICAL.length} medical + ${UNA_NONMEDICAL.length} non-medical)`);
  console.log(`\n  final bank size: ${qs.length} → ${updated.length}`);
  const byType: Record<string, number> = {};
  for (const q of updated) byType[q.type] = (byType[q.type] ?? 0) + 1;
  for (const [t, n] of Object.entries(byType)) console.log(`    ${t.padEnd(15)} ${n}`);
}

process();
