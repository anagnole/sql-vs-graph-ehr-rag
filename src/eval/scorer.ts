/**
 * Scorers — compare LLM answers against ground truth.
 *
 * Strategies by question type:
 * - simple-lookup: F1 for set answers, fuzzy match for single values
 * - multi-hop: fuzzy match (extracts key value)
 * - temporal: fuzzy match on trend + values
 * - cohort: numeric extraction + tolerance
 * - reasoning: fuzzy keyword overlap
 */

import type { EvalQuestion, RunResult, ScoredResult } from './types.js';

// ─── Main scoring dispatch ───────────────────────────────────────────────────

export function score(q: EvalQuestion, r: RunResult): ScoredResult {
  if (r.error || !r.answer) {
    // Timeouts and system errors never count as correct — they mean we
    // failed to evaluate the question, not that the model abstained. A clean
    // empty answer (error==null, answer=='') on an unanswerable question
    // still counts as a correct refusal.
    const isSystemError = !!r.error;
    if (q.type === 'unanswerable' && !isSystemError) {
      return { ...r, score: 1, scoreMethod: 'unanswerable', groundTruth: q.answer };
    }
    return { ...r, score: 0, scoreMethod: 'error', groundTruth: q.answer };
  }

  // Unanswerable scoring: check if the LLM correctly refused/abstained
  if (q.type === 'unanswerable') {
    return { ...r, score: unanswerableScore(r.answer), scoreMethod: 'unanswerable', groundTruth: q.answer };
  }

  // Negation scoring: GT is always "No. X is not ...". Token overlap FAILS here
  // because "Yes, patient has X" has high token overlap with "No, patient does
  // not have X". We need polarity-aware scoring.
  if (q.type === 'negation') {
    return { ...r, score: negationScore(r.answer), scoreMethod: 'negation', groundTruth: q.answer };
  }

  // Normalize whitespace between numbers and their units (e.g. "6.0 %" → "6.0%",
  // "134 mg/dL" → "134mg/dL") so trivially-formatted-differently numeric answers
  // score correctly instead of tripping the token-overlap fuzzy matcher.
  // Also canonicalize English date expressions ("May 1, 2019", "1 May 2019") to
  // ISO YYYY-MM-DD so temporal answers match GT regardless of the model's chosen
  // format. Only monthname-based forms are normalized — numeric forms like
  // "05/01/2019" are locale-ambiguous and left alone.
  const preprocess = (s: string) => normalizeDates(
    s.toLowerCase().trim().replace(/(\d+(?:\.\d+)?)\s+(%|mg|ml|mmhg|units?|kg|cm|beats)/gi, '$1$2'),
  );
  const answer = preprocess(r.answer);
  const truth = preprocess(q.answer);

  // Check if answer is a semicolon-separated list (set comparison)
  if (truth.includes(';')) {
    return { ...r, score: f1Score(truth, answer), scoreMethod: 'f1', groundTruth: q.answer };
  }

  // Numeric scoring: any answer whose ground truth starts with a number + unit/word.
  // Previously this was restricted to cohort questions, but any question-type with
  // a numeric answer (e.g. a lab value in a multi-hop question) should use it.
  const numMatch = truth.match(/^(\d+(?:\.\d+)?)/);
  if (numMatch && (q.type === 'cohort' || /^\d+(?:\.\d+)?\s*(%|mg|ml|mmhg|units?|kg|cm|beats|patients?)/i.test(truth))) {
    return { ...r, score: numericScore(truth, answer), scoreMethod: 'numeric', groundTruth: q.answer };
  }

  // Default: fuzzy token overlap
  return { ...r, score: fuzzyScore(truth, answer), scoreMethod: 'fuzzy', groundTruth: q.answer };
}

// ─── F1 scorer (set comparison) ──────────────────────────────────────────────

function f1Score(truth: string, answer: string): number {
  const truthSet = new Set(
    truth.split(';').map(s => normalize(s)).filter(Boolean),
  );
  const answerTokens = normalize(answer);

  // Check which truth items appear in the answer
  let found = 0;
  for (const item of truthSet) {
    // Fuzzy: check if the key words of the item appear in the answer
    const keywords = item.split(/\s+/).filter(w => w.length > 3);
    const matched = keywords.filter(k => answerTokens.includes(k)).length;
    if (keywords.length > 0 && matched / keywords.length >= 0.5) {
      found++;
    }
  }

  const precision = found / Math.max(truthSet.size, 1);
  const recall = found / truthSet.size;

  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

// ─── Numeric scorer ──────────────────────────────────────────────────────────

// Units the scoring pipeline recognises. Must stay in sync with the routing
// regex in `score()` above so numeric routing and unit extraction agree.
const UNIT_ALT = '%|mg|ml|mmhg|units?|kg|cm|beats|patients?';

function numericScore(truth: string, answer: string): number {
  const truthNum = extractNumber(truth);
  if (truthNum === null) return fuzzyScore(truth, answer);

  // When the ground truth has a unit, prefer numbers in the answer that are
  // adjacent to that same unit. This stops us from grabbing digits inside
  // patient names ("Juan88") or UUIDs when the real value ("145.3 mg/dL")
  // appears later in a verbose answer.
  let answerNum: number | null = null;
  const truthUnitMatch = truth.match(new RegExp(`^\\d+(?:\\.\\d+)?\\s*(${UNIT_ALT})`, 'i'));
  if (truthUnitMatch) {
    const unit = truthUnitMatch[1];
    const unitRe = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit}`, 'gi');
    let bestDist = Infinity;
    for (const m of answer.matchAll(unitRe)) {
      const n = parseFloat(m[1]);
      const d = Math.abs(n - truthNum);
      if (d < bestDist) { bestDist = d; answerNum = n; }
    }
  }

  // Fallback: first standalone number in the answer. Skips digits inside
  // alphanumeric tokens (patient names, UUIDs) via a lookbehind / lookahead
  // on word characters.
  if (answerNum === null) answerNum = extractStandaloneNumber(answer);

  if (answerNum === null) return fuzzyScore(truth, answer);

  if (truthNum === 0) return answerNum === 0 ? 1 : 0;

  const relError = Math.abs(truthNum - answerNum) / truthNum;
  // Within 10% = 1.0, within 25% = 0.5, worse = 0
  if (relError <= 0.1) return 1;
  if (relError <= 0.25) return 0.5;
  return 0;
}

// ─── Fuzzy token overlap scorer ──────────────────────────────────────────────

function fuzzyScore(truth: string, answer: string): number {
  const truthTokens = tokenize(truth);
  const answerTokens = new Set(tokenize(answer));

  if (truthTokens.length === 0) return answer.length === 0 ? 1 : 0;

  let matches = 0;
  for (const t of truthTokens) {
    if (answerTokens.has(t)) matches++;
  }

  return matches / truthTokens.length;
}

// ─── Unanswerable scorer ────────────────────────────────────────────────────

/**
 * Score whether the LLM correctly identified a question as unanswerable.
 * 1.0 = correctly refused/abstained
 * 0.0 = provided a fabricated answer (hallucination)
 * 0.5 = hedged but still attempted an answer
 */
function unanswerableScore(answer: string): number {
  const lower = answer.toLowerCase();
  const refusalPatterns = [
    'not found', 'no record', 'not available', 'cannot find',
    'no data', 'not in the', 'no information', 'unable to find',
    'does not exist', 'not present', 'no patient', 'cannot determine',
    'cannot be determined', 'not possible to', 'no such patient',
    'i cannot', 'i could not', 'i don\'t have', 'i was unable',
    'there is no', 'there are no', 'no results',
    'unanswerable', 'cannot answer', 'not answerable',
    'no diagnosis', 'not diagnosed', 'no .* recorded',
    'does not include', 'does not contain', 'not include',
    'no .* found', 'no .* available', 'has no',
    'not have any', 'don\'t have any', 'no evidence of',
    'no .* in the system', 'no .* in their',
  ];
  // Use regex for patterns with wildcards
  const hasRefusal = refusalPatterns.some((p) => {
    if (p.includes('.*')) return new RegExp(p).test(lower);
    return lower.includes(p);
  });
  if (hasRefusal) return 1;

  // Check for hedging patterns that still provide an answer
  const hedgePatterns = [
    'however', 'but based on', 'i\'m not sure but',
    'it appears', 'it seems', 'possibly',
  ];
  const hasHedge = hedgePatterns.some((p) => lower.includes(p));
  if (hasHedge) return 0.5;

  // If the answer is confident and specific, it's a hallucination
  return 0;
}

// ─── Negation scorer ─────────────────────────────────────────────────────────

/**
 * Score a negation question where the ground truth is always negative.
 * 1.0 = correctly negated (the LLM said no / not / does not have)
 * 0.0 = incorrectly affirmed (the LLM claimed the patient has the thing)
 * 0.5 = ambiguous (neither clear affirmation nor clear negation)
 */
function negationScore(answer: string): number {
  const lower = answer.toLowerCase().trim();
  if (!lower) return 0;

  // Strong negative markers — leading or standalone
  if (/^no[.,\s]/.test(lower) || lower === 'no') return 1;
  const strongNegatives = [
    'does not have', 'is not', 'not in the', 'not recorded',
    'no record of', 'no evidence of', 'not currently', 'not taking',
    'not prescribed', 'has not', 'no .* in the patient',
    'does not appear', 'cannot find', 'not listed',
    'no .* recorded', 'not on ', 'not included',
  ];
  const hasNegative = strongNegatives.some((p) =>
    p.includes('.*') ? new RegExp(p).test(lower) : lower.includes(p),
  );
  if (hasNegative) return 1;

  // Strong positive markers — the LLM hallucinated an affirmation
  const strongPositives = [
    'yes', 'has been', 'currently taking', 'is taking',
    'is prescribed', 'has a diagnosis', 'was diagnosed',
    'underwent', 'has had', 'is on ',
  ];
  const hasPositive = strongPositives.some((p) => lower.includes(p));
  if (hasPositive) return 0;

  // Ambiguous: no clear polarity marker
  return 0.5;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s.%]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(s: string): string[] {
  return normalize(s).split(' ').filter(t => t.length > 2);
}

function extractNumber(s: string): number | null {
  const match = s.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

// Canonicalize English monthname dates into ISO YYYY-MM-DD so answers like
// "May 1, 2019" or "1 May 2019" match a GT of "2019-05-01" under fuzzy/F1
// scoring. Deliberately skips numeric-only forms ("5/1/2019" vs "1/5/2019")
// — those are locale-ambiguous and we'd risk silently flipping values.
const MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04',
  jun: '06', jul: '07', aug: '08',
  sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

function normalizeDates(s: string): string {
  // "May 1, 2019" / "May 01, 2019" / "may 1 2019"
  let out = s.replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi,
    (_, mo, d, y) => `${y}-${MONTHS[mo.toLowerCase()]}-${String(d).padStart(2, '0')}`);
  // "1 May 2019" / "01 May 2019"
  out = out.replace(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?\s+(\d{4})\b/gi,
    (_, d, mo, y) => `${y}-${MONTHS[mo.toLowerCase()]}-${String(d).padStart(2, '0')}`);
  return out;
}

/**
 * Like extractNumber but skips digits that sit inside an alphanumeric token
 * (patient names like "Juan88", UUIDs like "000a359a-408b-..."). A number is
 * "standalone" if it is not preceded or followed by a letter.
 */
function extractStandaloneNumber(s: string): number | null {
  // Reject digit runs that touch any alphanumeric on either side — that
  // rules out names like "Juan88", UUID segments like "000a359a", and also
  // prevents the regex from matching a shorter prefix of an embedded run
  // (e.g. "00" out of "000a359a").
  const match = s.match(/(?<![A-Za-z0-9])(\d+(?:\.\d+)?)(?![A-Za-z0-9])/);
  return match ? parseFloat(match[1]) : null;
}
