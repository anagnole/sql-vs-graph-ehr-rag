/**
 * Scorer golden fixture — locks in behaviour across every scoring branch so
 * we catch regressions before spending money on full eval runs.
 *
 * Run with:
 *   npx tsx --test src/eval/scorer.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score } from './scorer.js';
import type { EvalQuestion, RunResult } from './types.js';

type QType = EvalQuestion['type'];

function q(type: QType, gt: string): EvalQuestion {
  return {
    id: 'X',
    type,
    question: '',
    answer: gt,
    patientIds: [],
    supportingRecordIds: [],
    domain: 'test',
  } as EvalQuestion;
}

function r(overrides: Partial<RunResult> & Pick<RunResult, 'answer'>): RunResult {
  return {
    questionId: 'X',
    system: 'graph',
    model: 'test',
    latencyMs: 1,
    ...overrides,
  };
}

function scored(type: QType, gt: string, ans: string, opts: Partial<RunResult> = {}) {
  return score(q(type, gt), r({ answer: ans, ...opts }));
}

// ─── Error paths ─────────────────────────────────────────────────────────────

test('error: timeout on simple-lookup scores 0', () => {
  const s = scored('simple-lookup', '145.3 mg/dL', '', { error: 'Timeout after 120000ms' });
  assert.equal(s.score, 0);
  assert.equal(s.scoreMethod, 'error');
});

test('error: timeout on unanswerable scores 0 (regression: was 1)', () => {
  const s = scored('unanswerable', 'UNANSWERABLE: no data', '', { error: 'Timeout after 120000ms' });
  assert.equal(s.score, 0, 'timeouts must never count as correct abstentions');
  assert.equal(s.scoreMethod, 'error');
});

test('error: CLI error on unanswerable scores 0', () => {
  const s = scored('unanswerable', 'UNANSWERABLE', '', { error: 'Claude CLI exit 1' });
  assert.equal(s.score, 0);
});

test('error: clean empty answer on unanswerable scores 1 (model abstained)', () => {
  const s = scored('unanswerable', 'UNANSWERABLE', '');
  assert.equal(s.score, 1);
  assert.equal(s.scoreMethod, 'unanswerable');
});

test('error: clean empty answer on simple-lookup scores 0', () => {
  const s = scored('simple-lookup', '145.3', '');
  assert.equal(s.score, 0);
});

// ─── Unanswerable scoring ────────────────────────────────────────────────────

test('unanswerable: explicit refusal patterns', () => {
  const patterns = [
    'Patient has no documented HIV diagnosis.',
    'I cannot find that information in the record.',
    'No record of this procedure exists.',
    'Patient is not in the system.',
    'There is no diagnosis of lupus.',
  ];
  for (const p of patterns) {
    const s = scored('unanswerable', 'UNANSWERABLE', p);
    assert.equal(s.score, 1, `should score 1: "${p}"`);
  }
});

test('unanswerable: hallucinated answer scores 0', () => {
  const s = scored('unanswerable', 'UNANSWERABLE', 'The patient was diagnosed with HIV in 2020.');
  assert.equal(s.score, 0);
});

test('unanswerable: hedged answer scores 0.5', () => {
  const s = scored('unanswerable', 'UNANSWERABLE', 'It appears the patient may have had this, but the record is unclear.');
  assert.equal(s.score, 0.5);
});

// ─── Negation scoring ────────────────────────────────────────────────────────

test('negation: "No, patient is not on warfarin" scores 1', () => {
  const s = scored('negation', 'No. Patient is not on warfarin.', 'No, patient is not on warfarin.');
  assert.equal(s.score, 1);
});

test('negation: correct negative via "does not have" scores 1', () => {
  const s = scored('negation', 'No. Patient does not have diabetes.', 'Patient does not have diabetes.');
  assert.equal(s.score, 1);
});

test('negation: hallucinated affirmation scores 0', () => {
  const s = scored('negation', 'No. Patient is not on warfarin.', 'Yes, the patient is taking warfarin.');
  assert.equal(s.score, 0);
});

test('negation: ambiguous answer scores 0.5', () => {
  const s = scored('negation', 'No. Patient is not on warfarin.', 'The record is unclear about warfarin.');
  assert.equal(s.score, 0.5);
});

// ─── F1 (semicolon-separated list) scoring ──────────────────────────────────

test('f1: perfect list match scores 1', () => {
  const s = scored(
    'simple-lookup',
    'Chronic sinusitis (disorder); Essential hypertension (disorder); Prediabetes (finding)',
    'Chronic sinusitis disorder, Essential hypertension disorder, Prediabetes finding',
  );
  assert.equal(s.scoreMethod, 'f1');
  assert.ok(s.score > 0.9, `expected near-1, got ${s.score}`);
});

test('f1: missing one item reduces score', () => {
  const s = scored(
    'simple-lookup',
    'Chronic sinusitis; Essential hypertension; Prediabetes',
    'Chronic sinusitis, Essential hypertension',
  );
  assert.equal(s.scoreMethod, 'f1');
  assert.ok(s.score < 1 && s.score > 0.5, `expected partial, got ${s.score}`);
});

test('f1: empty answer scores 0', () => {
  const s = scored('simple-lookup', 'A; B; C', '');
  assert.equal(s.score, 0);
});

// ─── Numeric scoring, unit-aware ────────────────────────────────────────────

test('numeric: SL-19 verbose sql-t2s answer scores 1 (regression: was 0)', () => {
  const s = scored(
    'simple-lookup',
    '145.3 mg/dL (recorded 2023-08-06)',
    'The most recent Total Cholesterol value for patient Juan88 Mann644 (ID: 000a359a-408b-1d70-fcd5-4189096a9e29) is:\n- Value: 145.3 mg/dL\n- Date: 2023-08-06',
  );
  assert.equal(s.score, 1, 'verbose answer with patient-name digits must still score correctly');
  assert.equal(s.scoreMethod, 'numeric');
});

test('numeric: terse exact-match answer scores 1', () => {
  const s = scored('simple-lookup', '145.3 mg/dL', '**145.3 mg/dL**');
  assert.equal(s.score, 1);
});

test('numeric: wrong value in verbose answer scores 0', () => {
  const s = scored(
    'simple-lookup',
    '145.3 mg/dL',
    'Patient Juan88 Mann644 total cholesterol is 210.5 mg/dL',
  );
  assert.equal(s.score, 0);
});

test('numeric: within 10% scores 1', () => {
  const s = scored('simple-lookup', '145.3 mg/dL', 'The value is 150 mg/dL');
  assert.equal(s.score, 1);
});

test('numeric: within 25% but over 10% scores 0.5', () => {
  const s = scored('simple-lookup', '145.3 mg/dL', 'The value is 170 mg/dL');
  assert.equal(s.score, 0.5);
});

test('numeric: over 25% error scores 0', () => {
  const s = scored('simple-lookup', '145.3 mg/dL', 'The value is 300 mg/dL');
  assert.equal(s.score, 0);
});

test('numeric: percent units handled', () => {
  const s = scored('multi-hop', '6.3%', 'The A1C value is 6.3%');
  assert.equal(s.score, 1);
});

test('numeric: answer with no unit falls back to standalone number', () => {
  const s = scored('simple-lookup', '145.3 mg/dL', '145.3');
  assert.equal(s.score, 1);
});

// ─── Numeric scoring, cohort path (no unit routing) ─────────────────────────

test('numeric: cohort count with UUID preamble scores 1 (regression)', () => {
  const s = scored(
    'cohort',
    '25 patients',
    'Looking at patient IDs 000a359a and 003934f5, I count 25 matching patients',
  );
  assert.equal(s.score, 1, 'UUID digits must not be mistaken for the cohort count');
});

test('numeric: cohort count exact', () => {
  const s = scored('cohort', '25 patients', 'There are 25 patients matching the criteria.');
  assert.equal(s.score, 1);
});

test('numeric: cohort wrong count scores 0', () => {
  const s = scored('cohort', '25 patients', 'I count 50 patients matching.');
  assert.equal(s.score, 0);
});

// ─── Fuzzy scoring ──────────────────────────────────────────────────────────

test('fuzzy: high token overlap scores near 1', () => {
  const s = scored(
    'reasoning',
    'Well-controlled diabetes with stable A1C trend',
    'The patient has well-controlled diabetes with a stable A1C trend over time',
  );
  assert.equal(s.scoreMethod, 'fuzzy');
  assert.ok(s.score >= 0.8, `expected >=0.8, got ${s.score}`);
});

test('fuzzy: zero overlap scores 0', () => {
  const s = scored(
    'reasoning',
    'Well-controlled diabetes with stable A1C trend',
    'The weather forecast calls for rain.',
  );
  assert.equal(s.score, 0);
});

// ─── Normalisation ──────────────────────────────────────────────────────────

test('normalisation: whitespace between number and unit is collapsed', () => {
  const s1 = scored('simple-lookup', '6.0 %', 'A1C: 6.0%');
  const s2 = scored('simple-lookup', '6.0%', 'A1C: 6.0 %');
  assert.equal(s1.score, 1);
  assert.equal(s2.score, 1);
});

test('normalisation: case-insensitive unit match', () => {
  const s = scored('simple-lookup', '145.3 mg/dL', '145.3 MG/DL');
  assert.equal(s.score, 1);
});

// ─── Date-format tolerance (R4) ─────────────────────────────────────────────

test('date: "May 1, 2019" matches ISO GT "2019-05-01"', () => {
  const s = scored('temporal', '2019-05-01', 'The patient was first diagnosed with prediabetes on May 1, 2019.');
  assert.ok(s.score >= 0.5, `expected >=0.5 for paraphrased date, got ${s.score}`);
});

test('date: "1 May 2019" (DMY) matches ISO GT', () => {
  const s = scored('temporal', '2019-05-01', 'Date of first prediabetes: 1 May 2019.');
  assert.ok(s.score >= 0.5);
});

test('date: abbreviated month "Jan 5, 2020" matches ISO GT', () => {
  const s = scored('temporal', '2020-01-05', 'Diagnosed Jan 5, 2020.');
  assert.ok(s.score >= 0.5);
});

test('date: ordinal suffix "May 1st, 2019" matches ISO GT', () => {
  const s = scored('temporal', '2019-05-01', 'The patient got it May 1st, 2019.');
  assert.ok(s.score >= 0.5);
});

test('date: numeric 5/1/2019 form is NOT transformed (ambiguous) — scores 0', () => {
  // We explicitly chose not to rewrite numeric-only date forms because
  // "5/1/2019" could be 5 Jan or 1 May. Any future change should update
  // this test too.
  const s = scored('temporal', '2019-05-01', 'The date was 5/1/2019.');
  assert.equal(s.score, 0);
});

// ─── Tier-aware GT regression (R10) ─────────────────────────────────────────

test('cohort: tier-aware GT swap — scoring uses whatever run.ts placed in q.answer', () => {
  // run.ts line 116 swaps q.answer for groundTruthByTier[tier] in tier mode.
  // From the scorer's view, q.answer is already the tier-specific GT.
  // Verify "3042 patients" scores 1 against tier-20000 GT, not against some
  // cached default.
  const s200 = scored('cohort', '34 patients', '34 patients have both.');
  const s20k = scored('cohort', '3042 patients', '3042 patients have both.');
  assert.equal(s200.score, 1);
  assert.equal(s20k.score, 1);
  // And that the tier-200 answer against tier-20000 GT still scores 0 —
  // confirms we're measuring the swap, not accidentally accepting anything.
  const crossTier = scored('cohort', '3042 patients', '34 patients have both.');
  assert.equal(crossTier.score, 0, 'wrong-tier answer must not leak through');
});
