/**
 * PostgreSQL ingestion — loads Phase 2 generated data into Postgres.
 *
 * Streams patients.json entry-by-entry, batches INSERTs for performance.
 * Providers/organizations loaded first (small, fits in memory).
 */

import pg from 'pg';
import { createReadStream, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createRequire } from 'node:module';
import { createSchema } from './schema.js';
import type {
  Patient, Encounter, Condition, Medication,
  Observation, Procedure, Provider, Organization,
} from '../parser/types.js';
import { normalizeObservation, LOINC_SPECS } from '../clinical/loinc-normalization.js';

// Synthea emits a mix of "2017-09-23" (bare date) and "2017-09-23T14:47:33Z"
// (ISO datetime). Postgres DATE columns only accept the bare form, so truncate
// anything with a 'T' separator. Empty/null passes through as null.
function toDateOrNull(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val);
  if (!s) return null;
  const tIdx = s.indexOf('T');
  return tIdx > 0 ? s.slice(0, tIdx) : s;
}

// Calendar-correct age calculation (matches the Kuzu-side ingest helper).
// Returns null if birthIso is empty/invalid.
function yearsBetween(birthIso: string | null, asOfIso: string): number | null {
  if (!birthIso) return null;
  const b = new Date(birthIso);
  const a = new Date(asOfIso);
  if (Number.isNaN(b.getTime()) || Number.isNaN(a.getTime())) return null;
  let years = a.getUTCFullYear() - b.getUTCFullYear();
  const monthDiff = a.getUTCMonth() - b.getUTCMonth();
  const dayDiff = a.getUTCDate() - b.getUTCDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) years--;
  return years;
}

const require = createRequire(import.meta.url);
const { parser } = require('stream-json');
const { streamObject } = require('stream-json/streamers/StreamObject');

const PROJECT_ROOT = join(import.meta.dirname, '../..');
const GEN_DIR = join(PROJECT_ROOT, 'data', 'generated');

// CLI: --tier <name> selects a tier-specific patient subset and database.
const argv = process.argv.slice(2);
function argValue(flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const tierFlag = argValue('--tier');
const sourceFlag = argValue('--source');
const allowlistFlag = argValue('--allowlist');
const asOfFlag = argValue('--as-of');
const providersFlag = argValue('--providers');
const appendMode = argv.includes('--append');

if (appendMode && !providersFlag) {
  console.error('--append requires --providers <shard providers json> — shards reference providers outside the already-loaded set (FK violations otherwise).');
  process.exit(1);
}

const SOURCE_PATH = sourceFlag ? resolve(sourceFlag) : join(GEN_DIR, 'patients.json');

// Load patient allowlist if tier specified — patients not in this set are skipped.
const tierAllowlist: Set<string> | null = (() => {
  if (allowlistFlag === 'none') return null;
  if (allowlistFlag) {
    return new Set(JSON.parse(readFileSync(resolve(allowlistFlag), 'utf-8')) as string[]);
  }
  if (!tierFlag || appendMode) return null;
  const tierFile = join(GEN_DIR, `tier-${tierFlag}.json`);
  if (!existsSync(tierFile)) {
    console.error(`Tier file not found: ${tierFile}`);
    process.exit(1);
  }
  const ids: string[] = JSON.parse(readFileSync(tierFile, 'utf-8'));
  return new Set(ids);
})();

const PG_DSN = process.env.PG_DSN ?? (
  tierFlag
    ? `postgresql://user@localhost:5432/ehrdb-${tierFlag}`
    : 'postgresql://user@localhost:5432/ehrdb'
);

if (tierFlag) {
  console.log(`Tier mode: --tier ${tierFlag}${appendMode ? ' (append)' : ''}`);
  console.log(`  Database: ${PG_DSN}`);
  if (tierAllowlist) console.log(`  Allowlist: ${tierAllowlist.size} patients`);
  if (sourceFlag) console.log(`  Source: ${SOURCE_PATH}`);
}

// ─── Batch inserter ──────────────────────────────────────────────────────────

class BatchInserter {
  private batches = new Map<string, { cols: string[]; rows: unknown[][] }>();
  private pool: pg.Pool;
  private batchSize: number;

  constructor(pool: pg.Pool, batchSize = 1000) {
    this.pool = pool;
    this.batchSize = batchSize;
  }

  add(table: string, cols: string[], values: unknown[]): void {
    let batch = this.batches.get(table);
    if (!batch) {
      batch = { cols, rows: [] };
      this.batches.set(table, batch);
    }
    batch.rows.push(values);
  }

  async flushIfNeeded(table: string, parentTables?: string[]): Promise<number> {
    const batch = this.batches.get(table);
    if (!batch || batch.rows.length < this.batchSize) return 0;
    // Flush parent tables first to satisfy FK constraints
    if (parentTables) {
      for (const pt of parentTables) {
        await this.flush(pt);
      }
    }
    return this.flush(table);
  }

  async flush(table: string): Promise<number> {
    const batch = this.batches.get(table);
    if (!batch || batch.rows.length === 0) return 0;

    const { cols, rows } = batch;
    const placeholders = rows.map((_, i) =>
      `(${cols.map((_, j) => `$${i * cols.length + j + 1}`).join(',')})`
    ).join(',');

    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${placeholders} ON CONFLICT DO NOTHING`;
    const flat = rows.flat();

    await this.pool.query(sql, flat);
    const count = rows.length;
    batch.rows = [];
    return count;
  }

  async flushAll(): Promise<void> {
    for (const table of this.batches.keys()) {
      await this.flush(table);
    }
  }
}

// ─── Main ingestion ──────────────────────────────────────────────────────────

async function ingest() {
  console.log('Starting PostgreSQL data ingestion...');
  const startTime = Date.now();

  const pool = new pg.Pool({ connectionString: PG_DSN });

  try {
    if (appendMode) {
      const probe = await pool.query(`SELECT COUNT(*) AS cnt FROM patient`);
      console.log(`Append mode: existing schema retained (${probe.rows[0].cnt} patients already loaded).`);
    } else {
      // Drop existing tables and recreate
      console.log('Creating schema (with FTS)...');
      await pool.query(`
        DROP TABLE IF EXISTS observation_reference_range CASCADE;
        DROP TABLE IF EXISTS procedure_ CASCADE;
        DROP TABLE IF EXISTS observation CASCADE;
        DROP TABLE IF EXISTS medication CASCADE;
        DROP TABLE IF EXISTS condition CASCADE;
        DROP TABLE IF EXISTS encounter CASCADE;
        DROP TABLE IF EXISTS patient CASCADE;
        DROP TABLE IF EXISTS provider CASCADE;
        DROP TABLE IF EXISTS organization CASCADE;
      `);
      await createSchema(pool, true);
    }

    // Reference-range table: one row per curated LOINC code. Loaded first so
    // observation rows don't depend on it (it's a lookup, not an FK).
    console.log('Loading observation reference ranges...');
    let refRangeCount = 0;
    for (const spec of LOINC_SPECS) {
      const range = spec.range;
      await pool.query(
        `INSERT INTO observation_reference_range
           (code, canonical_unit, normal_low, normal_high, critical_low, critical_high, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (code) DO NOTHING`,
        [
          spec.code,
          spec.conversion.canonicalUnit,
          range?.normalLow ?? null,
          range?.normalHigh ?? null,
          range?.criticalLow ?? null,
          range?.criticalHigh ?? null,
          range?.source ?? null,
        ],
      );
      refRangeCount++;
    }
    console.log(`  Reference ranges: ${refRangeCount} LOINC codes`);

    // age_years computed as of the ingest date (or at death if the patient died
    // before then). Stored once; re-ingest is the refresh mechanism, same as
    // the Kuzu side.
    const ingestDateIso = asOfFlag ?? new Date().toISOString().slice(0, 10);
    if (asOfFlag) console.log(`age_years reference date pinned to ${asOfFlag}`);

    const batch = new BatchInserter(pool, 500);

    // ── 1. Providers & Organizations ─────────────────────────────────────
    // In append mode the source is the shard's provider universe; inserts are
    // ON CONFLICT DO NOTHING so overlap with already-loaded providers is free.
    const providersPath = appendMode ? resolve(providersFlag!) : join(GEN_DIR, 'providers.json');
    console.log(`Loading ${providersPath}...`);
    const providersRaw: Record<string, { provider: Provider; organization: Organization | null }> =
      JSON.parse(readFileSync(providersPath, 'utf-8'));

    const orgSet = new Set<string>();
    for (const entry of Object.values(providersRaw)) {
      const o = entry.organization;
      if (o && !orgSet.has(o.id)) {
        orgSet.add(o.id);
        batch.add('organization',
          ['organization_id', 'name', 'city', 'state', 'zip', 'phone'],
          [o.id, o.name, o.city, o.state, o.zip, o.phone],
        );
      }
    }
    await batch.flush('organization');
    console.log(`  Organizations: ${orgSet.size}`);

    for (const entry of Object.values(providersRaw)) {
      const p = entry.provider;
      batch.add('provider',
        ['provider_id', 'organization_id', 'name', 'gender', 'specialty'],
        [p.id, p.organizationId, p.name, p.gender, p.specialty],
      );
    }
    await batch.flush('provider');
    console.log(`  Providers: ${Object.keys(providersRaw).length}`);

    // ── 2. Stream source JSON ──────────────────────────────────────────
    console.log(`Streaming ${SOURCE_PATH}...`);

    const counts = { patients: 0, encounters: 0, conditions: 0, medications: 0, observations: 0, procedures: 0 };

    await pipeline(
      createReadStream(SOURCE_PATH),
      parser(),
      streamObject(),
      new Transform({
        objectMode: true,
        async transform(chunk: { key: string; value: unknown }, _encoding, callback) {
          const entry = chunk.value as {
            patient: Patient; encounters: Encounter[];
            conditions: Condition[]; medications: Medication[];
            observations: Observation[]; procedures: Procedure[];
          };

          const pat = entry.patient;
          if (tierAllowlist && !tierAllowlist.has(pat.id)) { callback(); return; }
          const birthDate = toDateOrNull(pat.birthDate);
          const deathDate = toDateOrNull(pat.deathDate);
          // If deceased before the ingest date, age is age-at-death; otherwise
          // age as of the ingest date. Matches the Kuzu side's logic.
          const ageReference = deathDate && deathDate < ingestDateIso ? deathDate : ingestDateIso;
          const ageYears = yearsBetween(birthDate, ageReference);
          batch.add('patient',
            ['patient_id', 'first_name', 'last_name', 'birth_date', 'death_date', 'age_years', 'gender', 'race', 'ethnicity', 'marital_status', 'city', 'state', 'zip'],
            [pat.id, pat.firstName, pat.lastName, birthDate, deathDate, ageYears, pat.gender, pat.race, pat.ethnicity, pat.maritalStatus, pat.city, pat.state, pat.zip],
          );
          await batch.flushIfNeeded('patient');
          counts.patients++;

          for (const e of entry.encounters) {
            batch.add('encounter',
              ['encounter_id', 'patient_id', 'provider_id', 'organization_id', 'encounter_class', 'code', 'description', 'start_date', 'stop_date', 'reason_code', 'reason_description'],
              [e.id, e.patientId, e.providerId || null, e.organizationId || null, e.encounterClass, e.code, e.description, toDateOrNull(e.startDate), toDateOrNull(e.stopDate), e.reasonCode, e.reasonDescription],
            );
            await batch.flushIfNeeded('encounter', ['patient']);
            counts.encounters++;
          }

          for (const c of entry.conditions) {
            batch.add('condition',
              ['condition_id', 'patient_id', 'encounter_id', 'code', 'system', 'description', 'start_date', 'stop_date'],
              [c.id, c.patientId, c.encounterId || null, c.code, c.system, c.description, toDateOrNull(c.startDate), toDateOrNull(c.stopDate)],
            );
            await batch.flushIfNeeded('condition', ['patient', 'encounter']);
            counts.conditions++;
          }

          for (const m of entry.medications) {
            batch.add('medication',
              ['medication_id', 'patient_id', 'encounter_id', 'code', 'description', 'start_date', 'stop_date', 'reason_code', 'reason_description'],
              [m.id, m.patientId, m.encounterId || null, m.code, m.description, toDateOrNull(m.startDate), toDateOrNull(m.stopDate), m.reasonCode, m.reasonDescription],
            );
            await batch.flushIfNeeded('medication', ['patient', 'encounter']);
            counts.medications++;
          }

          for (const o of entry.observations) {
            const norm = normalizeObservation(o.code, o.value, o.units);
            batch.add('observation',
              ['observation_id', 'patient_id', 'encounter_id', 'category', 'code', 'description', 'value', 'units', 'value_canonical', 'units_canonical', 'type', 'date'],
              [o.id, o.patientId, o.encounterId || null, o.category, o.code, o.description, o.value, o.units, norm.valueCanonical, norm.unitCanonical, o.type, toDateOrNull(o.date)],
            );
            await batch.flushIfNeeded('observation', ['patient', 'encounter']);
            counts.observations++;
          }

          for (const p of entry.procedures) {
            batch.add('procedure_',
              ['procedure_id', 'patient_id', 'encounter_id', 'code', 'system', 'description', 'start_date', 'stop_date', 'reason_code', 'reason_description'],
              [p.id, p.patientId, p.encounterId || null, p.code, p.system, p.description, toDateOrNull(p.startDate), toDateOrNull(p.stopDate), p.reasonCode, p.reasonDescription],
            );
            await batch.flushIfNeeded('procedure_', ['patient', 'encounter']);
            counts.procedures++;
          }

          if (counts.patients % 500 === 0) {
            process.stdout.write(`\r  Streamed ${counts.patients} patients...`);
          }
          callback();
        },
      }),
    );

    // Flush in FK-safe order: parents before children
    await batch.flush('patient');
    await batch.flush('encounter');
    await batch.flush('condition');
    await batch.flush('medication');
    await batch.flush('observation');
    await batch.flush('procedure_');

    console.log(`\r  Patients:     ${counts.patients}`);
    console.log(`  Encounters:   ${counts.encounters}`);
    console.log(`  Conditions:   ${counts.conditions}`);
    console.log(`  Medications:  ${counts.medications}`);
    console.log(`  Observations: ${counts.observations}`);
    console.log(`  Procedures:   ${counts.procedures}`);

    // ── 3. Verify counts ─────────────────────────────────────────────────
    console.log('\nVerifying row counts...');
    const tables = ['patient', 'encounter', 'condition', 'medication', 'observation', 'procedure_', 'provider', 'organization'];
    for (const t of tables) {
      const res = await pool.query(`SELECT COUNT(*) AS cnt FROM ${t}`);
      console.log(`  ${t}: ${res.rows[0].cnt}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nPostgreSQL ingestion complete in ${elapsed}s.`);

  } finally {
    await pool.end();
  }
}

ingest().catch((err) => {
  console.error('Ingestion failed:', err);
  process.exit(1);
});
