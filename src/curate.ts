import type { GroundTruthQuestion, QuestionType } from "./questions/types.js";

const QUESTIONS_PER_TYPE = 60;
const UNANSWERABLE_TARGET = 15;
const MAX_PER_PATIENT = 4;
const MIN_DOMAINS_PER_TYPE = 3;

/**
 * Select ~160 questions from candidates:
 * - 30 per main question type (5 types = 150)
 * - 10 unanswerable questions
 * - At least 3 clinical domains per type
 * - No more than 4 questions per patient
 * - Deterministic selection (sorted by ID, stratified by domain)
 */
export function curateQuestions(candidates: GroundTruthQuestion[]): GroundTruthQuestion[] {
  const selected: GroundTruthQuestion[] = [];
  const patientQuestionCount = new Map<string, number>();

  const types: QuestionType[] = ["simple-lookup", "multi-hop", "temporal", "cohort", "reasoning", "unanswerable"];

  for (const type of types) {
    const target = type === "unanswerable" ? UNANSWERABLE_TARGET : QUESTIONS_PER_TYPE;
    const typeCandidates = candidates
      .filter((q) => q.type === type)
      .sort((a, b) => a.id.localeCompare(b.id));

    // Group by domain
    const byDomain = new Map<string, GroundTruthQuestion[]>();
    for (const q of typeCandidates) {
      const list = byDomain.get(q.domain);
      if (list) list.push(q);
      else byDomain.set(q.domain, [q]);
    }

    const domains = [...byDomain.keys()].sort();
    const typeSelected: GroundTruthQuestion[] = [];

    // Round-robin across domains to ensure coverage
    let domainIdx = 0;
    let exhausted = 0;
    const domainPointers = new Map<string, number>();
    for (const d of domains) domainPointers.set(d, 0);

    while (typeSelected.length < target && exhausted < domains.length) {
      const domain = domains[domainIdx % domains.length];
      const domainQuestions = byDomain.get(domain)!;
      let ptr = domainPointers.get(domain)!;

      let added = false;
      while (ptr < domainQuestions.length) {
        const q = domainQuestions[ptr];
        ptr++;
        domainPointers.set(domain, ptr);

        // Check patient limit (skip for cohort questions with no specific patient)
        if (q.patientIds.length > 0) {
          const overLimit = q.patientIds.some(
            (pid) => (patientQuestionCount.get(pid) ?? 0) >= MAX_PER_PATIENT
          );
          if (overLimit) continue;
        }

        typeSelected.push(q);
        for (const pid of q.patientIds) {
          patientQuestionCount.set(pid, (patientQuestionCount.get(pid) ?? 0) + 1);
        }
        added = true;
        break;
      }

      if (!added && ptr >= domainQuestions.length) {
        exhausted++;
      }
      domainIdx++;
    }

    // Verify domain coverage
    const selectedDomains = new Set(typeSelected.map((q) => q.domain));
    if (selectedDomains.size < MIN_DOMAINS_PER_TYPE && selectedDomains.size < domains.length) {
      console.warn(
        `Warning: ${type} only covers ${selectedDomains.size} domains (min ${MIN_DOMAINS_PER_TYPE})`
      );
    }

    selected.push(...typeSelected);
  }

  return selected;
}
