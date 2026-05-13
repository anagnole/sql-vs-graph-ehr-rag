/**
 * PostgreSQL schema for the EHR baseline.
 * 9 tables mirroring the Kuzu graph node tables — kept normalized (3NF-ish)
 * deliberately so the comparison tests the paradigm (shared-concept KG vs
 * relational) and not incidental data-quality differences.
 *
 * Schema parity with Kuzu (as of April 2026):
 *   - DATE columns (not TEXT) for birth/death/start/stop/date
 *   - patient.age_years INT (derived at ingest)
 *   - observation.value_canonical DOUBLE + units_canonical TEXT
 *   - observation_reference_range(code PK, normal_low/high, critical_low/high, source)
 *     mirroring Kuzu's ConceptObservation reference range fields
 */

import pg from 'pg';

const PG_DSN = process.env.PG_DSN ?? 'postgresql://user@localhost:5432/ehrdb';

export function getPool(): pg.Pool {
  return new pg.Pool({ connectionString: PG_DSN });
}

export const SCHEMA_DDL = `
-- Organizations
CREATE TABLE IF NOT EXISTS organization (
  organization_id TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  city            TEXT,
  state           TEXT,
  zip             TEXT,
  phone           TEXT
);

-- Providers
CREATE TABLE IF NOT EXISTS provider (
  provider_id     TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organization(organization_id),
  name            TEXT NOT NULL,
  gender          TEXT,
  specialty       TEXT
);
CREATE INDEX IF NOT EXISTS idx_provider_org ON provider(organization_id);

-- Patients. age_years is derived at ingest so the LLM doesn't have to do date
-- arithmetic (same reasoning as Kuzu's Patient.age_years).
CREATE TABLE IF NOT EXISTS patient (
  patient_id     TEXT PRIMARY KEY,
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  birth_date     DATE NOT NULL,
  death_date     DATE,
  age_years      INT,
  gender         TEXT,
  race           TEXT,
  ethnicity      TEXT,
  marital_status TEXT,
  city           TEXT,
  state          TEXT,
  zip            TEXT
);
CREATE INDEX IF NOT EXISTS idx_patient_age ON patient(age_years);

-- Encounters
CREATE TABLE IF NOT EXISTS encounter (
  encounter_id       TEXT PRIMARY KEY,
  patient_id         TEXT NOT NULL REFERENCES patient(patient_id),
  provider_id        TEXT REFERENCES provider(provider_id),
  organization_id    TEXT REFERENCES organization(organization_id),
  encounter_class    TEXT,
  code               TEXT,
  description        TEXT,
  start_date         DATE,
  stop_date          DATE,
  reason_code        TEXT,
  reason_description TEXT
);
CREATE INDEX IF NOT EXISTS idx_encounter_patient ON encounter(patient_id);
CREATE INDEX IF NOT EXISTS idx_encounter_provider ON encounter(provider_id);

-- Conditions
CREATE TABLE IF NOT EXISTS condition (
  condition_id TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL REFERENCES patient(patient_id),
  encounter_id TEXT REFERENCES encounter(encounter_id),
  code         TEXT,
  system       TEXT,
  description  TEXT,
  start_date   DATE,
  stop_date    DATE
);
CREATE INDEX IF NOT EXISTS idx_condition_patient ON condition(patient_id);
CREATE INDEX IF NOT EXISTS idx_condition_encounter ON condition(encounter_id);
CREATE INDEX IF NOT EXISTS idx_condition_code ON condition(code);

-- Medications
CREATE TABLE IF NOT EXISTS medication (
  medication_id      TEXT PRIMARY KEY,
  patient_id         TEXT NOT NULL REFERENCES patient(patient_id),
  encounter_id       TEXT REFERENCES encounter(encounter_id),
  code               TEXT,
  description        TEXT,
  start_date         DATE,
  stop_date          DATE,
  reason_code        TEXT,
  reason_description TEXT
);
CREATE INDEX IF NOT EXISTS idx_medication_patient ON medication(patient_id);
CREATE INDEX IF NOT EXISTS idx_medication_encounter ON medication(encounter_id);

-- Observations. value is kept TEXT (some labs are categorical like "Negative");
-- value_canonical holds the unit-normalized numeric for labs in the LOINC
-- normalization registry. units_canonical matches (e.g. 'mg/dL' for glucose).
CREATE TABLE IF NOT EXISTS observation (
  observation_id   TEXT PRIMARY KEY,
  patient_id       TEXT NOT NULL REFERENCES patient(patient_id),
  encounter_id     TEXT REFERENCES encounter(encounter_id),
  category         TEXT,
  code             TEXT,
  description      TEXT,
  value            TEXT,
  units            TEXT,
  value_canonical  DOUBLE PRECISION,
  units_canonical  TEXT,
  type             TEXT,
  date             DATE
);
CREATE INDEX IF NOT EXISTS idx_observation_patient ON observation(patient_id);
CREATE INDEX IF NOT EXISTS idx_observation_encounter ON observation(encounter_id);
CREATE INDEX IF NOT EXISTS idx_observation_code ON observation(code);
CREATE INDEX IF NOT EXISTS idx_observation_date ON observation(date);

-- Procedures
CREATE TABLE IF NOT EXISTS procedure_ (
  procedure_id       TEXT PRIMARY KEY,
  patient_id         TEXT NOT NULL REFERENCES patient(patient_id),
  encounter_id       TEXT REFERENCES encounter(encounter_id),
  code               TEXT,
  system             TEXT,
  description        TEXT,
  start_date         DATE,
  stop_date          DATE,
  reason_code        TEXT,
  reason_description TEXT
);
CREATE INDEX IF NOT EXISTS idx_procedure_patient ON procedure_(patient_id);
CREATE INDEX IF NOT EXISTS idx_procedure_encounter ON procedure_(encounter_id);

-- Observation reference ranges. One row per LOINC code that has a curated
-- normal/critical range. Mirrors the normal_*/critical_* fields the Kuzu side
-- exposes on ConceptObservation. Keeps the LLM's JOIN-burden symmetric with
-- the KG's concept-traversal requirement.
CREATE TABLE IF NOT EXISTS observation_reference_range (
  code          TEXT PRIMARY KEY,
  canonical_unit TEXT,
  normal_low    DOUBLE PRECISION,
  normal_high   DOUBLE PRECISION,
  critical_low  DOUBLE PRECISION,
  critical_high DOUBLE PRECISION,
  source        TEXT
);
`;

export const FTS_DDL = `
-- Full-text search columns and indexes

-- Patient FTS
ALTER TABLE patient ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(city,''))
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_patient_fts ON patient USING GIN(fts);

-- Condition FTS
ALTER TABLE condition ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(description,'') || ' ' || coalesce(code,''))
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_condition_fts ON condition USING GIN(fts);

-- Medication FTS
ALTER TABLE medication ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(description,'') || ' ' || coalesce(code,''))
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_medication_fts ON medication USING GIN(fts);

-- Observation FTS
ALTER TABLE observation ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(description,'') || ' ' || coalesce(code,''))
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_observation_fts ON observation USING GIN(fts);

-- Provider FTS
ALTER TABLE provider ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(name,'') || ' ' || coalesce(specialty,''))
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_provider_fts ON provider USING GIN(fts);

-- Organization FTS
ALTER TABLE organization ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(name,'') || ' ' || coalesce(city,''))
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_organization_fts ON organization USING GIN(fts);
`;

/** Concise schema description for LLM prompting (text-to-SQL). */
export const SCHEMA_DESC = `PostgreSQL EHR database — 9 tables:

patient(patient_id PK, first_name, last_name, birth_date DATE, death_date DATE|NULL, age_years INT, gender, race, ethnicity, marital_status, city, state, zip)
  -- age_years is precomputed at ingest. PREFER filtering by age_years over computing from birth_date.

provider(provider_id PK, organization_id FK→organization, name, gender, specialty)

organization(organization_id PK, name, city, state, zip, phone)

encounter(encounter_id PK, patient_id FK→patient, provider_id FK→provider, organization_id FK→organization, encounter_class, code, description, start_date DATE, stop_date DATE, reason_code, reason_description)

condition(condition_id PK, patient_id FK→patient, encounter_id FK→encounter, code, system, description, start_date DATE, stop_date DATE|NULL)
  -- stop_date IS NULL = active condition

medication(medication_id PK, patient_id FK→patient, encounter_id FK→encounter, code, description, start_date DATE, stop_date DATE|NULL, reason_code, reason_description)
  -- stop_date IS NULL = active medication

observation(observation_id PK, patient_id FK→patient, encounter_id FK→encounter, category, code, description, value TEXT, units TEXT, value_canonical DOUBLE PRECISION|NULL, units_canonical TEXT|NULL, type, date DATE)
  -- LOINC codes for labs. PREFER value_canonical for numeric aggregation — it is the unit-normalized numeric value (NULL for labs not in the LOINC normalization registry or non-numeric results).
  -- units_canonical is the matching canonical unit (e.g. 'mg/dL' for glucose, '%' for HbA1c).
  -- Fall back to value::float only when value_canonical is NULL.

procedure_(procedure_id PK, patient_id FK→patient, encounter_id FK→encounter, code, system, description, start_date DATE, stop_date DATE, reason_code, reason_description)

observation_reference_range(code PK, canonical_unit, normal_low, normal_high, critical_low, critical_high, source)
  -- Curated clinical reference ranges for common LOINC codes (HbA1c, glucose, cholesterol panel, creatinine, eGFR, BP, BMI, Hb, electrolytes).
  -- JOIN observation.code = observation_reference_range.code to flag abnormal labs.
  -- A value v is abnormal if v < normal_low OR v > normal_high, critical if v < critical_low OR v > critical_high.

Rules:
- Dates are real DATE columns. ORDER BY / BETWEEN work as expected.
- For numeric aggregation on labs, USE value_canonical (DOUBLE). Do NOT cast the raw 'value' TEXT column unless value_canonical is NULL.
- Condition and medication description matching is case-insensitive partial — use ILIKE with '%...%' wrapping.
- For 'active' filters use stop_date IS NULL; for 'resolved' use stop_date IS NOT NULL.
- Limit result sets to at most 100 rows unless the question asks for a count.`;

/** Create all tables + indexes. Optionally include FTS. */
export async function createSchema(pool: pg.Pool, includeFts = false): Promise<void> {
  await pool.query(SCHEMA_DDL);
  if (includeFts) {
    await pool.query(FTS_DDL);
  }
}
