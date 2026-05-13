/**
 * Tier-aware curation for the cohort scaling experiment.
 *
 * Loads candidate questions from ground-truth.json and curates a question
 * bank where every patient-specific question references a patient in the
 * smallest tier (first-N patients sorted by ID). Cohort questions have no
 * patient anchor — they apply to all tiers but their ground truth must be
 * recomputed per tier at eval time.
 *
 * Anchored selection guarantees the same 80–100 questions can be evaluated
 * identically across tier_200, tier_2000, and tier_20000 — paired statistics
 * (McNemar, Cochran's Q) become valid across tiers, not just within them.
 *
 * Run: npx tsx scripts/curate-tiers.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GroundTruthQuestion, QuestionType } from "../src/questions/types.js";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const ANCHOR_SIZE = 200;
const TARGET_PER_TYPE_PRIMARY = 60; // ideal
const UNANSWERABLE_TARGET = 28; // expanded from 15 → parity with EHRSQL's ~10% ratio
const NEGATION_TARGET = 20; // new category — absence-reasoning questions
const TARGET_PER_TYPE_FALLBACK = 40; // accept if primary infeasible
const MAX_PER_PATIENT = 6; // permissive — enables cross-type reuse on the same patient

// Process most-constrained types FIRST so they claim their limited patient pool
// before less-constrained types grab those patients. Cohort, negation, and
// unanswerable come last.
const TYPE_ORDER: QuestionType[] = ["temporal", "simple-lookup", "reasoning", "multi-hop", "cohort", "negation", "unanswerable"];

/**
 * Load patient IDs sorted ascending. Filters to ALIVE patients only — Synthea
 * generates ~13% deceased patients in addition to the requested -p N alive,
 * and tier sizes (200/2000/20000) are defined in alive counts to match the
 * Synthea generation flag and produce a cleaner experimental story.
 */
function loadSortedPatientIds(): string[] {
  const csv = readFileSync(join(PROJECT_ROOT, "data/synthea/patients.csv"), "utf-8");
  const lines = csv.split("\n");
  const header = lines[0].split(",");
  const idIdx = header.indexOf("Id");
  const deathIdx = header.indexOf("DEATHDATE");
  if (idIdx < 0 || deathIdx < 0) throw new Error("patients.csv missing Id or DEATHDATE column");

  const alive: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split(",");
    if (!cols[deathIdx] || cols[deathIdx].trim() === "") alive.push(cols[idIdx]);
  }
  return alive.sort();
}

function curateAnchored(
  candidates: GroundTruthQuestion[],
  anchor: Set<string>,
  targetPerType: number,
  maxPerPatient: number,
): { selected: GroundTruthQuestion[]; perTypeActual: Record<string, number> } {
  const selected: GroundTruthQuestion[] = [];
  const patientCount = new Map<string, number>();
  const perTypeActual: Record<string, number> = {};

  for (const type of TYPE_ORDER) {
    const typeTarget =
      type === "unanswerable" ? UNANSWERABLE_TARGET :
      type === "negation" ? NEGATION_TARGET :
      targetPerType;
    // Filter to candidates within the anchor (cohort/unanswerable questions may have no patientIds)
    const inAnchor = candidates.filter((q) => {
      if (q.type !== type) return false;
      if (q.patientIds.length === 0) return true; // cohort
      return q.patientIds.some((pid) => anchor.has(pid));
    });

    // Group by domain for stratified picking
    const byDomain = new Map<string, GroundTruthQuestion[]>();
    for (const q of inAnchor) {
      const list = byDomain.get(q.domain) ?? [];
      list.push(q);
      byDomain.set(q.domain, list);
    }
    const domains = [...byDomain.keys()].sort();
    const pointers = new Map<string, number>(domains.map((d) => [d, 0]));
    const typeSelected: GroundTruthQuestion[] = [];

    let domainIdx = 0;
    const exhaustedDomains = new Set<string>();
    while (typeSelected.length < typeTarget && exhaustedDomains.size < domains.length) {
      const domain = domains[domainIdx % domains.length];
      domainIdx++;

      if (exhaustedDomains.has(domain)) continue;

      const domainQs = byDomain.get(domain)!;
      let ptr = pointers.get(domain)!;
      let added = false;

      while (ptr < domainQs.length) {
        const q = domainQs[ptr++];
        pointers.set(domain, ptr);

        if (q.patientIds.length > 0) {
          const overLimit = q.patientIds.some(
            (pid) => (patientCount.get(pid) ?? 0) >= maxPerPatient,
          );
          if (overLimit) continue;
        }

        typeSelected.push(q);
        for (const pid of q.patientIds) {
          patientCount.set(pid, (patientCount.get(pid) ?? 0) + 1);
        }
        added = true;
        break;
      }

      // Domain is exhausted only when we've consumed all its questions AND didn't add one this round
      if (!added && ptr >= domainQs.length) exhaustedDomains.add(domain);
    }

    perTypeActual[type] = typeSelected.length;
    selected.push(...typeSelected);
  }

  return { selected, perTypeActual };
}

function main() {
  console.log("─── Tier-aware curation ───\n");
  const sortedIds = loadSortedPatientIds();
  console.log(`Total patients: ${sortedIds.length}`);
  const anchor = new Set(sortedIds.slice(0, ANCHOR_SIZE));
  console.log(`Anchor size: ${anchor.size} (first ${ANCHOR_SIZE} sorted by ID)\n`);

  const candidates: GroundTruthQuestion[] = JSON.parse(
    readFileSync(join(PROJECT_ROOT, "data/generated/ground-truth.json"), "utf-8"),
  );
  console.log(`Total candidate questions: ${candidates.length}`);

  // Per-type candidates within anchor
  const types: QuestionType[] = ["simple-lookup", "multi-hop", "temporal", "cohort", "reasoning", "negation", "unanswerable"];
  console.log("\nCandidates within first-200 anchor:");
  for (const t of types) {
    const inAnchor = candidates.filter((q) => {
      if (q.type !== t) return false;
      if (q.patientIds.length === 0) return true;
      return q.patientIds.some((pid) => anchor.has(pid));
    });
    console.log(`  ${t.padEnd(16)}: ${inAnchor.length}`);
  }

  // Try primary target (30/type, 10 unanswerable)
  function targetFor(t: QuestionType) {
    if (t === "unanswerable") return UNANSWERABLE_TARGET;
    if (t === "negation") return NEGATION_TARGET;
    return TARGET_PER_TYPE_PRIMARY;
  }
  function targetForFallback(t: QuestionType) {
    if (t === "unanswerable") return UNANSWERABLE_TARGET;
    if (t === "negation") return NEGATION_TARGET;
    return TARGET_PER_TYPE_FALLBACK;
  }

  console.log(`\n─── Attempt 1: ${TARGET_PER_TYPE_PRIMARY} per type (${UNANSWERABLE_TARGET} unanswerable), max ${MAX_PER_PATIENT} per patient ───`);
  const { selected: r1, perTypeActual: a1 } = curateAnchored(
    candidates,
    anchor,
    TARGET_PER_TYPE_PRIMARY,
    MAX_PER_PATIENT,
  );
  for (const t of types) {
    const got = a1[t] ?? 0;
    const target = targetFor(t);
    const mark = got >= target ? "✓" : "✗";
    console.log(`  ${mark} ${t.padEnd(16)}: ${got}/${target}`);
  }
  console.log(`Total: ${r1.length}`);

  // Accept primary if all main types hit target (unanswerable shortfall is OK)
  const mainTypes: QuestionType[] = ["simple-lookup", "multi-hop", "temporal", "cohort", "reasoning"];
  const allHit = mainTypes.every((t) => (a1[t] ?? 0) >= targetFor(t));
  let final: GroundTruthQuestion[];
  let finalPerType: Record<string, number>;

  if (allHit) {
    console.log(`\n✓ Hit all targets. Using ${r1.length}-question bank.`);
    final = r1;
    finalPerType = a1;
  } else {
    console.log(`\n─── Attempt 2: ${TARGET_PER_TYPE_FALLBACK} per type (fallback) ───`);
    const { selected: r2, perTypeActual: a2 } = curateAnchored(
      candidates,
      anchor,
      TARGET_PER_TYPE_FALLBACK,
      MAX_PER_PATIENT,
    );
    for (const t of types) {
      const got = a2[t] ?? 0;
      const target = targetForFallback(t);
      const mark = got >= target ? "✓" : "✗";
      console.log(`  ${mark} ${t.padEnd(16)}: ${got}/${target}`);
    }
    console.log(`Total: ${r2.length}`);
    final = r2;
    finalPerType = a2;
  }

  // Sanity check: verify all patient-specific questions are within anchor
  const violations = final.filter((q) => {
    if (q.patientIds.length === 0) return false;
    return !q.patientIds.some((pid) => anchor.has(pid));
  });
  if (violations.length > 0) {
    console.error(`\n⚠️  ${violations.length} questions have patientIds outside the anchor!`);
    process.exit(1);
  }

  // Write outputs
  const outFile = join(PROJECT_ROOT, "data/generated/evaluation-questions-tiered.json");
  writeFileSync(outFile, JSON.stringify(final, null, 2));
  console.log(`\nWrote ${final.length} questions to data/generated/evaluation-questions-tiered.json`);

  // Also write the tier patient ID lists
  const tier200 = sortedIds.slice(0, 200);
  const tier2000 = sortedIds.slice(0, 2000);
  const tier20000 = sortedIds.slice(0, 20000);
  writeFileSync(join(PROJECT_ROOT, "data/generated/tier-200.json"), JSON.stringify(tier200, null, 2));
  writeFileSync(join(PROJECT_ROOT, "data/generated/tier-2000.json"), JSON.stringify(tier2000, null, 2));
  writeFileSync(join(PROJECT_ROOT, "data/generated/tier-20000.json"), JSON.stringify(tier20000, null, 2));
  console.log(`Wrote tier patient lists: tier-200.json (200), tier-2000.json (2000), tier-20000.json (20000)`);

  // Also report distinct patients used
  const usedPatients = new Set<string>();
  for (const q of final) for (const pid of q.patientIds) usedPatients.add(pid);
  console.log(`\nDistinct patients used by curated bank: ${usedPatients.size}`);
  console.log(`(All within first-${ANCHOR_SIZE} anchor: ${[...usedPatients].every((p) => anchor.has(p))})`);
}

main();
