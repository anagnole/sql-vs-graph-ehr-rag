import { join } from "node:path";
import { readCsv } from "./csv-reader.js";
import type {
  RawPatient,
  RawEncounter,
  RawCondition,
  RawMedication,
  RawObservation,
  RawProcedure,
  RawProvider,
  RawOrganization,
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

function mapPatient(raw: RawPatient): Patient {
  return {
    id: raw.Id,
    firstName: raw.FIRST,
    lastName: raw.LAST,
    birthDate: raw.BIRTHDATE,
    deathDate: raw.DEATHDATE || null,
    gender: raw.GENDER,
    race: raw.RACE,
    ethnicity: raw.ETHNICITY,
    maritalStatus: raw.MARITAL || "",
    city: raw.CITY,
    state: raw.STATE,
    zip: raw.ZIP,
  };
}

function mapEncounter(raw: RawEncounter): Encounter {
  return {
    id: raw.Id,
    patientId: raw.PATIENT,
    providerId: raw.PROVIDER,
    organizationId: raw.ORGANIZATION,
    encounterClass: raw.ENCOUNTERCLASS,
    code: raw.CODE,
    description: raw.DESCRIPTION,
    startDate: raw.START,
    stopDate: raw.STOP,
    reasonCode: raw.REASONCODE || "",
    reasonDescription: raw.REASONDESCRIPTION || "",
  };
}

let condCounter = 0;
function mapCondition(raw: RawCondition): Condition {
  return {
    id: `COND-${++condCounter}`,
    patientId: raw.PATIENT,
    encounterId: raw.ENCOUNTER,
    code: raw.CODE,
    system: raw.SYSTEM,
    description: raw.DESCRIPTION,
    startDate: raw.START,
    stopDate: raw.STOP || null,
  };
}

let medCounter = 0;
function mapMedication(raw: RawMedication): Medication {
  return {
    id: `MED-${++medCounter}`,
    patientId: raw.PATIENT,
    encounterId: raw.ENCOUNTER,
    code: raw.CODE,
    description: raw.DESCRIPTION,
    startDate: raw.START,
    stopDate: raw.STOP || null,
    reasonCode: raw.REASONCODE || "",
    reasonDescription: raw.REASONDESCRIPTION || "",
  };
}

let obsCounter = 0;
function mapObservation(raw: RawObservation): Observation {
  return {
    id: `OBS-${++obsCounter}`,
    patientId: raw.PATIENT,
    encounterId: raw.ENCOUNTER,
    category: raw.CATEGORY,
    code: raw.CODE,
    description: raw.DESCRIPTION,
    value: raw.VALUE,
    units: raw.UNITS,
    type: raw.TYPE,
    date: raw.DATE,
  };
}

let procCounter = 0;
function mapProcedure(raw: RawProcedure): Procedure {
  return {
    id: `PROC-${++procCounter}`,
    patientId: raw.PATIENT,
    encounterId: raw.ENCOUNTER,
    code: raw.CODE,
    system: raw.SYSTEM,
    description: raw.DESCRIPTION,
    startDate: raw.START,
    stopDate: raw.STOP || "",
    reasonCode: raw.REASONCODE || "",
    reasonDescription: raw.REASONDESCRIPTION || "",
  };
}

function mapProvider(raw: RawProvider): Provider {
  return {
    id: raw.Id,
    organizationId: raw.ORGANIZATION,
    name: raw.NAME,
    gender: raw.GENDER,
    specialty: raw.SPECIALITY,
  };
}

function mapOrganization(raw: RawOrganization): Organization {
  return {
    id: raw.Id,
    name: raw.NAME,
    city: raw.CITY,
    state: raw.STATE,
    zip: raw.ZIP,
    phone: raw.PHONE,
  };
}

function buildIndex<T extends { patientId: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const list = map.get(item.patientId);
    if (list) list.push(item);
    else map.set(item.patientId, [item]);
  }
  return map;
}

function buildEncounterIndex<T extends { encounterId: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
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

export async function parseSyntheaData(dataDir: string): Promise<ParsedDataset> {
  // Reset counters
  condCounter = 0;
  medCounter = 0;
  obsCounter = 0;
  procCounter = 0;

  console.log("Reading CSVs...");
  const patients = (await readCsv<RawPatient>(join(dataDir, "patients.csv"))).map(mapPatient);
  console.log(`  ✓ patients (${patients.length})`);
  const encounters = (await readCsv<RawEncounter>(join(dataDir, "encounters.csv"))).map(mapEncounter);
  console.log(`  ✓ encounters (${encounters.length})`);
  const conditions = (await readCsv<RawCondition>(join(dataDir, "conditions.csv"))).map(mapCondition);
  console.log(`  ✓ conditions (${conditions.length})`);
  const medications = (await readCsv<RawMedication>(join(dataDir, "medications.csv"))).map(mapMedication);
  console.log(`  ✓ medications (${medications.length})`);
  const observations = (await readCsv<RawObservation>(join(dataDir, "observations.csv"))).map(mapObservation);
  console.log(`  ✓ observations (${observations.length})`);
  const procedures = (await readCsv<RawProcedure>(join(dataDir, "procedures.csv"))).map(mapProcedure);
  console.log(`  ✓ procedures (${procedures.length})`);
  const providers = (await readCsv<RawProvider>(join(dataDir, "providers.csv"))).map(mapProvider);
  console.log(`  ✓ providers (${providers.length})`);
  const organizations = (await readCsv<RawOrganization>(join(dataDir, "organizations.csv"))).map(mapOrganization);
  console.log(`  ✓ organizations (${organizations.length})`);

  console.log(
    `Parsed: ${patients.length} patients, ${encounters.length} encounters, ` +
      `${conditions.length} conditions, ${medications.length} medications, ` +
      `${observations.length} observations, ${procedures.length} procedures, ` +
      `${providers.length} providers, ${organizations.length} organizations`
  );

  console.log("Building indexes...");
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
      encounters: buildIndex(encounters),
      conditions: buildIndex(conditions),
      medications: buildIndex(medications),
      observations: buildIndex(observations),
      procedures: buildIndex(procedures),
    },
    byEncounter: {
      conditions: buildEncounterIndex(conditions),
      medications: buildEncounterIndex(medications),
      observations: buildEncounterIndex(observations),
      procedures: buildEncounterIndex(procedures),
    },
    encounterById: buildIdMap(encounters),
    providerById: buildIdMap(providers),
    organizationById: buildIdMap(organizations),
    patientById: buildIdMap(patients),
  };
}
