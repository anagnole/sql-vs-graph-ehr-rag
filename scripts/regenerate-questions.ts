/**
 * Regenerate questions from the existing patients.json + providers.json snapshots.
 *
 * This avoids re-running Synthea when the raw CSVs have been cleaned up.
 * Uses streaming JSON parser to handle the 7.8GB patients.json file.
 *
 * Run: npx tsx scripts/regenerate-questions.ts
 */
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ParsedDataset, Patient, Encounter, Condition, Medication, Observation, Procedure, Provider, Organization } from "../src/parser/types.js";
import { profileDataset, generateAllQuestions } from "../src/questions/index.js";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const GEN_DIR = join(PROJECT_ROOT, "data", "generated");

console.log("=== Regenerate Questions from Snapshots ===\n");

// ─── Load providers ─────────────────────────────────────────────────────────
console.log("Loading providers.json...");
const providerData: Record<string, { provider: Provider; organization: Organization | null }> =
  JSON.parse(readFileSync(join(GEN_DIR, "providers.json"), "utf-8"));

const providers: Provider[] = [];
const organizations: Organization[] = [];
const providerById = new Map<string, Provider>();
const organizationById = new Map<string, Organization>();
const orgSeen = new Set<string>();

for (const entry of Object.values(providerData)) {
  providers.push(entry.provider);
  providerById.set(entry.provider.id, entry.provider);
  if (entry.organization && !orgSeen.has(entry.organization.id)) {
    organizations.push(entry.organization);
    organizationById.set(entry.organization.id, entry.organization);
    orgSeen.add(entry.organization.id);
  }
}
console.log(`  ${providers.length} providers, ${organizations.length} organizations`);

// ─── Stream patients.json line by line ──────────────────────────────────────
// The file is ~7.8GB, so we parse it line by line instead of JSON.parse().
// Load anchor patient IDs — we only need these for question generation
const anchorFile = join(GEN_DIR, "tier-200.json");
const anchorIds = new Set<string>(JSON.parse(readFileSync(anchorFile, "utf-8")));
console.log(`Anchor: ${anchorIds.size} patients from tier-200.json`);

console.log("Streaming patients.json (loading anchor patients only)...");

const patients: Patient[] = [];
const allEncounters: Encounter[] = [];
const allConditions: Condition[] = [];
const allMedications: Medication[] = [];
const allObservations: Observation[] = [];
const allProcedures: Procedure[] = [];

const byPatient = {
  encounters: new Map<string, Encounter[]>(),
  conditions: new Map<string, Condition[]>(),
  medications: new Map<string, Medication[]>(),
  observations: new Map<string, Observation[]>(),
  procedures: new Map<string, Procedure[]>(),
};
const byEncounter = {
  conditions: new Map<string, Condition[]>(),
  medications: new Map<string, Medication[]>(),
  observations: new Map<string, Observation[]>(),
  procedures: new Map<string, Procedure[]>(),
};
const encounterById = new Map<string, Encounter>();
const patientById = new Map<string, Patient>();

const rl = createInterface({
  input: createReadStream(join(GEN_DIR, "patients.json"), { encoding: "utf-8" }),
  crlfDelay: Infinity,
});

let lineCount = 0;
let loaded = 0;
const logEvery = 50;

for await (const line of rl) {
  // Skip opening/closing braces
  const trimmed = line.trim();
  if (trimmed === "{" || trimmed === "}" || trimmed === "") continue;
  // Early exit once we've loaded all anchor patients
  if (loaded >= anchorIds.size) continue;

  // Each line is: "uuid": {bundle}, or "uuid": {bundle}
  // Remove trailing comma if present
  const cleaned = trimmed.endsWith(",") ? trimmed.slice(0, -1) : trimmed;

  // Find the JSON value after the first ":"
  const colonIdx = cleaned.indexOf(":");
  if (colonIdx < 0) continue;

  // Extract the patient ID from the key to check anchor membership before parsing
  const keyStr = cleaned.slice(0, colonIdx).trim();
  const patientId = keyStr.replace(/"/g, "");
  if (!anchorIds.has(patientId)) { lineCount++; continue; }

  const jsonStr = cleaned.slice(colonIdx + 1).trim();
  let bundle: {
    patient: Patient;
    encounters: Encounter[];
    conditions: Condition[];
    medications: Medication[];
    observations: Observation[];
    procedures: Procedure[];
  };

  try {
    bundle = JSON.parse(jsonStr);
  } catch {
    continue;
  }

  const p = bundle.patient;
  patients.push(p);
  patientById.set(p.id, p);

  // Index encounters
  byPatient.encounters.set(p.id, bundle.encounters);
  for (const e of bundle.encounters) {
    allEncounters.push(e);
    encounterById.set(e.id, e);
  }

  // Index conditions
  byPatient.conditions.set(p.id, bundle.conditions);
  for (const c of bundle.conditions) {
    allConditions.push(c);
    const list = byEncounter.conditions.get(c.encounterId) ?? [];
    list.push(c);
    byEncounter.conditions.set(c.encounterId, list);
  }

  // Index medications
  byPatient.medications.set(p.id, bundle.medications);
  for (const m of bundle.medications) {
    allMedications.push(m);
    const list = byEncounter.medications.get(m.encounterId) ?? [];
    list.push(m);
    byEncounter.medications.set(m.encounterId, list);
  }

  // Index observations
  byPatient.observations.set(p.id, bundle.observations);
  for (const o of bundle.observations) {
    allObservations.push(o);
    const list = byEncounter.observations.get(o.encounterId) ?? [];
    list.push(o);
    byEncounter.observations.set(o.encounterId, list);
  }

  // Index procedures
  byPatient.procedures.set(p.id, bundle.procedures);
  for (const pr of bundle.procedures) {
    allProcedures.push(pr);
    const list = byEncounter.procedures.get(pr.encounterId) ?? [];
    list.push(pr);
    byEncounter.procedures.set(pr.encounterId, list);
  }

  lineCount++;
  loaded++;
  if (loaded % logEvery === 0) {
    console.log(`  loaded ${loaded}/${anchorIds.size} anchor patients (scanned ${lineCount} lines)...`);
  }
}

console.log(`  Total: ${patients.length} patients, ${allEncounters.length} encounters`);
console.log(`  ${allConditions.length} conditions, ${allMedications.length} medications`);
console.log(`  ${allObservations.length} observations, ${allProcedures.length} procedures`);

// ─── Assemble dataset ───────────────────────────────────────────────────────
const dataset: ParsedDataset = {
  patients,
  encounters: allEncounters,
  conditions: allConditions,
  medications: allMedications,
  observations: allObservations,
  procedures: allProcedures,
  providers,
  organizations,
  byPatient,
  byEncounter,
  encounterById,
  providerById,
  organizationById,
  patientById,
};

// ─── Profile and generate ───────────────────────────────────────────────────
console.log("\nProfiling dataset...");
const profile = profileDataset(dataset);
console.log(`  Unique conditions: ${profile.conditionCounts.size}`);
console.log(`  Unique observation codes: ${profile.observationCoverage.size}`);
console.log(`  Unique medications: ${profile.medicationCounts.size}`);

const allQuestions = generateAllQuestions(dataset, profile);

// ─── Write outputs ──────────────────────────────────────────────────────────
console.log("\nWriting ground-truth.json...");
writeFileSync(join(GEN_DIR, "ground-truth.json"), JSON.stringify(allQuestions, null, 2));

// Quick stats
const types = ["simple-lookup", "multi-hop", "temporal", "cohort", "reasoning", "unanswerable"] as const;
console.log("\nCandidate counts:");
for (const t of types) {
  const count = allQuestions.filter((q) => q.type === t).length;
  const uniquePatients = new Set(allQuestions.filter((q) => q.type === t).flatMap((q) => q.patientIds));
  console.log(`  ${t.padEnd(16)}: ${count} questions, ${uniquePatients.size} unique patients`);
}
console.log(`Total: ${allQuestions.length}`);

// Stats
const stats = {
  patients: patients.length,
  encounters: allEncounters.length,
  conditions: allConditions.length,
  medications: allMedications.length,
  observations: allObservations.length,
  procedures: allProcedures.length,
  providers: providers.length,
  organizations: organizations.length,
  totalCandidateQuestions: allQuestions.length,
};
writeFileSync(join(GEN_DIR, "stats.json"), JSON.stringify(stats, null, 2));

console.log("\n=== Done. Run `npx tsx scripts/curate-tiers.ts` next to curate. ===");
