/**
 * Read a ParsedDataset back from `data/generated/patients.json` + `providers.json`
 * instead of the raw Synthea CSVs.
 *
 * Motivation: the 20k-patient Synthea CSVs were cleaned up at some point to save
 * disk space. The JSON snapshot (patients.json ≈ 7.3 GB) preserves the full
 * dataset in our internal shape (see snapshot.ts). This reader uses stream-json
 * to parse the file object-entry-by-entry so the 7 GB never sits in memory at
 * once. It also builds the indexes ParsedDataset needs so the question
 * generators don't care which source produced the dataset.
 *
 * Used automatically by generate.ts when encounters.csv is missing.
 */

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type {
  Patient,
  Encounter,
  Condition,
  Medication,
  Observation,
  Procedure,
  Provider,
  Organization,
  ParsedDataset,
} from "./types.js";

// stream-json is published as CJS; use createRequire for ESM interop.
const require = createRequire(import.meta.url);
const { parser } = require("stream-json") as { parser: () => NodeJS.ReadWriteStream };
const { streamObject } = require("stream-json/streamers/StreamObject") as {
  streamObject: () => NodeJS.ReadWriteStream;
};

interface PatientBundle {
  patient: Patient;
  encounters: Encounter[];
  conditions: Condition[];
  medications: Medication[];
  observations: Observation[];
  procedures: Procedure[];
}

interface ProviderEntry {
  provider: Provider;
  organization: Organization | null;
}

export async function parseSnapshotData(
  generatedDir: string,
  options?: { patientIdFilter?: Set<string> },
): Promise<ParsedDataset> {
  const patientsPath = join(generatedDir, "patients.json");
  const providersPath = join(generatedDir, "providers.json");
  const filter = options?.patientIdFilter ?? null;

  if (!existsSync(patientsPath)) {
    throw new Error(`patients.json not found at ${patientsPath}`);
  }
  if (!existsSync(providersPath)) {
    throw new Error(`providers.json not found at ${providersPath}`);
  }

  console.log(`Reading snapshot from ${generatedDir}...`);

  // Providers + organizations — small file, parse normally
  const providersJson = JSON.parse(readFileSync(providersPath, "utf-8")) as Record<string, ProviderEntry>;
  const providers: Provider[] = [];
  const organizationsMap = new Map<string, Organization>();
  for (const entry of Object.values(providersJson)) {
    providers.push(entry.provider);
    if (entry.organization && !organizationsMap.has(entry.organization.id)) {
      organizationsMap.set(entry.organization.id, entry.organization);
    }
  }
  const organizations = [...organizationsMap.values()];
  console.log(`  ✓ providers (${providers.length})`);
  console.log(`  ✓ organizations (${organizations.length})`);

  // Patient bundles — stream-parse to avoid loading 7 GB at once
  const patients: Patient[] = [];
  const encounters: Encounter[] = [];
  const conditions: Condition[] = [];
  const medications: Medication[] = [];
  const observations: Observation[] = [];
  const procedures: Procedure[] = [];

  const byPatientEncounters = new Map<string, Encounter[]>();
  const byPatientConditions = new Map<string, Condition[]>();
  const byPatientMedications = new Map<string, Medication[]>();
  const byPatientObservations = new Map<string, Observation[]>();
  const byPatientProcedures = new Map<string, Procedure[]>();

  let processed = 0;

  await new Promise<void>((resolve, reject) => {
    const pipeline = createReadStream(patientsPath).pipe(parser()).pipe(streamObject());

    pipeline.on("data", ({ value }: { key: string; value: PatientBundle }) => {
      const bundle = value;
      if (filter && !filter.has(bundle.patient.id)) return;
      patients.push(bundle.patient);
      if (bundle.encounters.length) {
        encounters.push(...bundle.encounters);
        byPatientEncounters.set(bundle.patient.id, bundle.encounters);
      }
      if (bundle.conditions.length) {
        conditions.push(...bundle.conditions);
        byPatientConditions.set(bundle.patient.id, bundle.conditions);
      }
      if (bundle.medications.length) {
        medications.push(...bundle.medications);
        byPatientMedications.set(bundle.patient.id, bundle.medications);
      }
      if (bundle.observations.length) {
        observations.push(...bundle.observations);
        byPatientObservations.set(bundle.patient.id, bundle.observations);
      }
      if (bundle.procedures.length) {
        procedures.push(...bundle.procedures);
        byPatientProcedures.set(bundle.patient.id, bundle.procedures);
      }
      processed++;
      if (processed % 2000 === 0) {
        console.log(`  patients read: ${processed}`);
      }
    });
    pipeline.on("end", () => resolve());
    pipeline.on("error", (err: Error) => reject(err));
  });

  console.log(
    `Parsed: ${patients.length} patients, ${encounters.length} encounters, ` +
      `${conditions.length} conditions, ${medications.length} medications, ` +
      `${observations.length} observations, ${procedures.length} procedures`,
  );

  console.log("Building encounter + entity indexes...");
  const byEncounterConditions = buildEncounterIndex(conditions);
  const byEncounterMedications = buildEncounterIndex(medications);
  const byEncounterObservations = buildEncounterIndex(observations);
  const byEncounterProcedures = buildEncounterIndex(procedures);

  const encounterById = buildIdMap(encounters);
  const providerById = buildIdMap(providers);
  const organizationById = buildIdMap(organizations);
  const patientById = buildIdMap(patients);

  return {
    patients,
    encounters,
    conditions,
    medications,
    observations,
    procedures,
    providers,
    organizations,
    byPatient: {
      encounters: byPatientEncounters,
      conditions: byPatientConditions,
      medications: byPatientMedications,
      observations: byPatientObservations,
      procedures: byPatientProcedures,
    },
    byEncounter: {
      conditions: byEncounterConditions,
      medications: byEncounterMedications,
      observations: byEncounterObservations,
      procedures: byEncounterProcedures,
    },
    encounterById,
    providerById,
    organizationById,
    patientById,
  };
}

function buildEncounterIndex<T extends { encounterId: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    if (!item.encounterId) continue;
    const list = map.get(item.encounterId);
    if (list) list.push(item);
    else map.set(item.encounterId, [item]);
  }
  return map;
}

function buildIdMap<T extends { id: string }>(items: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(item.id, item);
  return map;
}
