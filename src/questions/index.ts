import type { ParsedDataset } from "../parser/types.js";
import type { GroundTruthQuestion, DataProfile } from "./types.js";
import { generateSimpleLookup } from "./simple-lookup.js";
import { generateMultiHop } from "./multi-hop.js";
import { generateTemporal } from "./temporal.js";
import { generateCohort } from "./cohort.js";
import { generateReasoning } from "./reasoning.js";
import { generateNegation } from "./negation.js";
import { generateUnanswerable } from "./unanswerable.js";

export function profileDataset(ds: ParsedDataset): DataProfile {
  const conditionCounts = new Map<string, number>();
  const patientConditions = new Map<string, Set<string>>();

  for (const c of ds.conditions) {
    conditionCounts.set(c.description, (conditionCounts.get(c.description) ?? 0) + 1);
    let set = patientConditions.get(c.patientId);
    if (!set) {
      set = new Set();
      patientConditions.set(c.patientId, set);
    }
    set.add(c.description);
  }

  // Observation coverage by LOINC code
  const obsByCode = new Map<string, Set<string>>();
  const obsDescriptions = new Map<string, string>();
  for (const o of ds.observations) {
    let set = obsByCode.get(o.code);
    if (!set) {
      set = new Set();
      obsByCode.set(o.code, set);
    }
    set.add(o.patientId);
    obsDescriptions.set(o.code, o.description);
  }
  const observationCoverage = new Map<string, { description: string; patientCount: number }>();
  for (const [code, patients] of obsByCode) {
    observationCoverage.set(code, {
      description: obsDescriptions.get(code)!,
      patientCount: patients.size,
    });
  }

  // Medication counts
  const medicationCounts = new Map<string, number>();
  for (const m of ds.medications) {
    medicationCounts.set(m.description, (medicationCounts.get(m.description) ?? 0) + 1);
  }

  // Condition co-occurrences (per patient)
  const conditionCoOccurrences = new Map<string, number>();
  for (const conditions of patientConditions.values()) {
    const arr = [...conditions].sort();
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = `${arr[i]}||${arr[j]}`;
        conditionCoOccurrences.set(key, (conditionCoOccurrences.get(key) ?? 0) + 1);
      }
    }
  }

  // Encounter class counts
  const encounterClassCounts = new Map<string, number>();
  for (const e of ds.encounters) {
    encounterClassCounts.set(e.encounterClass, (encounterClassCounts.get(e.encounterClass) ?? 0) + 1);
  }

  return {
    totalPatients: ds.patients.length,
    totalEncounters: ds.encounters.length,
    conditionCounts,
    observationCoverage,
    medicationCounts,
    conditionCoOccurrences,
    encounterClassCounts,
  };
}

export function generateAllQuestions(
  ds: ParsedDataset,
  profile: DataProfile
): GroundTruthQuestion[] {
  console.log("\nGenerating questions...");
  const all: GroundTruthQuestion[] = [];

  const simple = generateSimpleLookup(ds, profile);
  console.log(`  simple-lookup: ${simple.length} candidates`);
  all.push(...simple);

  const multi = generateMultiHop(ds, profile);
  console.log(`  multi-hop: ${multi.length} candidates`);
  all.push(...multi);

  const temporal = generateTemporal(ds, profile);
  console.log(`  temporal: ${temporal.length} candidates`);
  all.push(...temporal);

  const cohort = generateCohort(ds, profile);
  console.log(`  cohort: ${cohort.length} candidates`);
  all.push(...cohort);

  const reasoning = generateReasoning(ds, profile);
  console.log(`  reasoning: ${reasoning.length} candidates`);
  all.push(...reasoning);

  const negation = generateNegation(ds, profile);
  console.log(`  negation: ${negation.length} candidates`);
  all.push(...negation);

  const unanswerable = generateUnanswerable(ds, profile);
  console.log(`  unanswerable: ${unanswerable.length} candidates`);
  all.push(...unanswerable);

  console.log(`Total candidates: ${all.length}`);
  return all;
}
