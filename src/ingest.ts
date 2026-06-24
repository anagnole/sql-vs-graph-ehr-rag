/**
 * Kuzu ingestion pipeline — shared concept node model.
 *
 * Strategy:
 * 1. Load providers/organizations (small, in memory)
 * 2. Stream patients.json — extract unique concepts into Maps, write relationship CSVs
 * 3. Write concept node CSVs from Maps
 * 4. Create schema (concept + instance node tables, rel tables with properties)
 * 5. COPY FROM: concept nodes first, then instances, then relationships
 * 6. Build cross-concept edges (TREATS, INDICATED_BY) from reason codes
 * 7. Rebuild FTS indexes on concept nodes
 */

import kuzu from 'kuzu';
import { createReadStream, readFileSync, writeFileSync, createWriteStream, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { parser } = require('stream-json');
const { streamObject } = require('stream-json/streamers/StreamObject');

import type {
  Patient, Encounter, Condition, Medication,
  Observation, Procedure, Provider, Organization,
} from './parser/types.js';
import { normalizeObservation, LOINC_SPECS, getReferenceRange } from './clinical/loinc-normalization.js';
import { COMPLICATION_EDGES } from './clinical/snomed-complications.js';

const PROJECT_ROOT = join(import.meta.dirname, '..');
const GEN_DIR = join(PROJECT_ROOT, 'data', 'generated');

// CLI: --tier <name> selects a tier-specific patient subset and DB path.
// Without --tier, ingests the full dataset into the default kuzu DB.
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
const finalizeMode = argv.includes('--finalize');
const skipFts = argv.includes('--no-fts');

if (appendMode && !providersFlag) {
  console.error('--append requires --providers <shard providers json>.');
  console.error('Shards reference providers outside the already-loaded set; appending without them fails on TREATED_BY/AT_ORGANIZATION COPY.');
  process.exit(1);
}

const DB_PATH = tierFlag
  ? join(PROJECT_ROOT, '.brainifai', 'data', `kuzu-${tierFlag}`)
  : join(PROJECT_ROOT, '.brainifai', 'data', 'kuzu');

const TMP_DIR = join(PROJECT_ROOT, tierFlag ? `.tmp-csv-${tierFlag}` : '.tmp-csv');

const SOURCE_PATH = sourceFlag ? resolve(sourceFlag) : join(GEN_DIR, 'patients.json');
const STATE_PATH = join(GEN_DIR, `ingest-state-${tierFlag ?? 'full'}.json`);

// Load patient allowlist if tier specified — patients not in this set are skipped
// during streaming, producing a Kuzu DB containing only the tier's cohort.
const tierAllowlist: Set<string> | null = (() => {
  if (allowlistFlag === 'none') return null;
  if (allowlistFlag) {
    return new Set(JSON.parse(readFileSync(resolve(allowlistFlag), 'utf-8')) as string[]);
  }
  if (!tierFlag || appendMode || finalizeMode) return null;
  const tierFile = join(GEN_DIR, `tier-${tierFlag}.json`);
  if (!existsSync(tierFile)) {
    console.error(`Tier file not found: ${tierFile}`);
    console.error(`Run: npx tsx scripts/curate-tiers.ts to generate tier-*.json files`);
    process.exit(1);
  }
  const ids: string[] = JSON.parse(readFileSync(tierFile, 'utf-8'));
  return new Set(ids);
})();

if (tierFlag) {
  const mode = finalizeMode ? ' (finalize)' : appendMode ? ' (append)' : '';
  console.log(`Tier mode: --tier ${tierFlag}${mode}`);
  console.log(`  DB path: ${DB_PATH}`);
  if (tierAllowlist) console.log(`  Allowlist: ${tierAllowlist.size} patients`);
  if (sourceFlag) console.log(`  Source: ${SOURCE_PATH}`);
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function escapeCsv(val: unknown): string {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Synthea emits a mix of bare dates ("2017-09-23") and ISO datetimes
// ("2017-09-23T14:47:33Z"). Kuzu's DATE type requires the bare form, so
// truncate anything with a 'T' separator. Empty/null passes through for NULL.
function toDateString(val: unknown): string {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (!s) return '';
  const tIdx = s.indexOf('T');
  return tIdx > 0 ? s.slice(0, tIdx) : s;
}

function writeCsvLine(fd: import('node:fs').WriteStream, values: unknown[]): void {
  fd.write(values.map(escapeCsv).join(',') + '\n');
}

function writeCsvHeader(fd: import('node:fs').WriteStream, headers: string[]): void {
  fd.write(headers.join(',') + '\n');
}

const DATE_FIELD_NAMES = new Set(['birth_date', 'death_date', 'start_date', 'stop_date', 'date']);

function mapOne(item: Record<string, unknown>, fieldMap: Record<string, string>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [camel, snake] of Object.entries(fieldMap)) {
    const raw = item[camel] ?? '';
    row[snake] = DATE_FIELD_NAMES.has(snake) ? toDateString(raw) : raw;
  }
  return row;
}

function toCsvLine(headers: string[], row: Record<string, unknown>): string {
  return headers.map((h) => escapeCsv(row[h])).join(',');
}

function writeCsvFromArray(filePath: string, headers: string[], items: object[], fieldMap: Record<string, string>): void {
  const lines = [headers.join(',')];
  for (const item of items) {
    lines.push(toCsvLine(headers, mapOne(item as Record<string, unknown>, fieldMap)));
  }
  writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

// ─── Field maps (unchanged tables) ──────────────────────────────────────────

const PATIENT_FIELDS: Record<string, string> = {
  id: 'patient_id', firstName: 'first_name', lastName: 'last_name',
  birthDate: 'birth_date', deathDate: 'death_date', gender: 'gender',
  race: 'race', ethnicity: 'ethnicity', maritalStatus: 'marital_status',
  city: 'city', state: 'state', zip: 'zip',
};

const ENCOUNTER_FIELDS: Record<string, string> = {
  id: 'encounter_id', patientId: 'patient_id', providerId: 'provider_id',
  organizationId: 'organization_id', encounterClass: 'encounter_class',
  code: 'code', description: 'description', startDate: 'start_date',
  stopDate: 'stop_date', reasonCode: 'reason_code', reasonDescription: 'reason_description',
};

const PROVIDER_FIELDS: Record<string, string> = {
  id: 'provider_id', organizationId: 'organization_id',
  name: 'name', gender: 'gender', specialty: 'specialty',
};

const ORGANIZATION_FIELDS: Record<string, string> = {
  id: 'organization_id', name: 'name', city: 'city',
  state: 'state', zip: 'zip', phone: 'phone',
};

// ─── Concept types (collected during streaming) ─────────────────────────────

interface ConceptCondition { code: string; system: string; description: string }
interface ConceptMedication { code: string; description: string }
interface ConceptObservation { code: string; description: string; category: string; units: string; type: string }
interface ConceptProcedure { code: string; system: string; description: string }

// ─── Cross-shard ingest state (append/finalize modes) ────────────────────────

interface IngestTotals {
  patients: number; encounters: number;
  conditions: number; medications: number; observations: number; procedures: number;
  providers: number; organizations: number;
}

interface IngestState {
  concepts: { conditions: string[]; medications: string[]; observations: string[]; procedures: string[] };
  written_edges: { treats: string[]; indicated_by: string[]; complication_of: string[]; reason_for: number };
  pending_edges: { treats: string[]; indicated_by: string[]; reason_for: [string, string][] };
  totals: IngestTotals;
  shards: { source: string; timestamp: string; patients: number; encounters: number }[];
}

function emptyState(): IngestState {
  return {
    concepts: { conditions: [], medications: [], observations: [], procedures: [] },
    written_edges: { treats: [], indicated_by: [], complication_of: [], reason_for: 0 },
    pending_edges: { treats: [], indicated_by: [], reason_for: [] },
    totals: { patients: 0, encounters: 0, conditions: 0, medications: 0, observations: 0, procedures: 0, providers: 0, organizations: 0 },
    shards: [],
  };
}

function loadState(): IngestState | null {
  if (!existsSync(STATE_PATH)) return null;
  return JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as IngestState;
}

function saveState(state: IngestState): void {
  writeFileSync(STATE_PATH, JSON.stringify(state), 'utf-8');
}

const FTS_INDEXES: [string, string][] = [
  ['Patient', 'patient_fts'],
  ['ConceptCondition', 'condition_fts'],
  ['ConceptMedication', 'medication_fts'],
  ['ConceptObservation', 'observation_fts'],
  ['ConceptProcedure', 'procedure_fts'],
  ['Provider', 'provider_fts'],
  ['Organization', 'organization_fts'],
];

const FTS_FIELDS: Record<string, string[]> = {
  Patient: ['first_name', 'last_name', 'city'],
  ConceptCondition: ['description', 'code'],
  ConceptMedication: ['description', 'code'],
  ConceptObservation: ['description', 'code'],
  ConceptProcedure: ['description', 'code'],
  Provider: ['name', 'specialty'],
  Organization: ['name', 'city'],
};

async function dropFtsIndexes(conn: InstanceType<typeof kuzu.Connection>): Promise<void> {
  for (const [table, index] of FTS_INDEXES) {
    try {
      await conn.query(`CALL DROP_FTS_INDEX('${table}', '${index}')`);
    } catch { /* may not exist */ }
  }
}

async function createFtsIndexes(conn: InstanceType<typeof kuzu.Connection>): Promise<void> {
  for (const [table, index] of FTS_INDEXES) {
    const fields = FTS_FIELDS[table].map((f) => `'${f}'`).join(', ');
    try {
      await conn.query(`CALL CREATE_FTS_INDEX('${table}', '${index}', [${fields}])`);
    } catch { /* may already exist */ }
  }
}

// ─── Main ingestion ─────────────────────────────────────────────────────────

async function ingest() {
  console.log(`Starting EHR data ingestion (concept node model)${appendMode ? ' — APPEND' : ''}...`);
  const startTime = Date.now();

  let state: IngestState;
  if (appendMode) {
    if (!existsSync(DB_PATH)) {
      console.error(`--append requires an existing DB at ${DB_PATH}`);
      process.exit(1);
    }
    const loaded = loadState();
    if (!loaded) {
      console.error(`--append requires the ingest state file at ${STATE_PATH}`);
      console.error('Run a fresh (non-append) ingest for this tier first.');
      process.exit(1);
    }
    state = loaded;
    console.log(`  State: ${state.totals.patients} patients ingested across ${state.shards.length} prior run(s)`);
  } else {
    state = emptyState();
  }

  const knownConditions = new Set(state.concepts.conditions);
  const knownMedications = new Set(state.concepts.medications);
  const knownObservations = new Set(state.concepts.observations);
  const knownProcedures = new Set(state.concepts.procedures);

  // Ensure parent dir exists. Kuzu refuses to use a pre-created directory —
  // it wants to initialize the DB itself, so we only mkdir the parent.
  mkdirSync(join(DB_PATH, '..'), { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });

  const db = new kuzu.Database(DB_PATH);
  const conn = new kuzu.Connection(db);

  try {
    // ── 1. Providers & Organizations ─────────────────────────────────────
    // Skipped in append mode: the provider universe is deterministic across
    // Synthea shards (name-based v3 UUIDs + pinned clinicianSeed), so the
    // initial ingest already loaded every provider/organization.

    let providers: Provider[] = [];
    let organizations: Organization[] = [];
    const orgFile = join(TMP_DIR, 'organizations.csv');
    const provFile = join(TMP_DIR, 'providers.csv');
    const affiliatedFile = join(TMP_DIR, 'affiliated_with_new.csv');

    if (!appendMode) {
      console.log('Loading providers.json...');
      const providersRaw: Record<string, { provider: Provider; organization: Organization }> =
        JSON.parse(readFileSync(join(GEN_DIR, 'providers.json'), 'utf-8'));

      const orgMap = new Map<string, Organization>();
      for (const entry of Object.values(providersRaw)) {
        providers.push(entry.provider);
        if (!orgMap.has(entry.organization.id)) {
          orgMap.set(entry.organization.id, entry.organization);
        }
      }
      organizations = [...orgMap.values()];

      writeCsvFromArray(orgFile, Object.values(ORGANIZATION_FIELDS), organizations, ORGANIZATION_FIELDS);
      console.log(`  Organizations: ${organizations.length}`);

      writeCsvFromArray(provFile, Object.values(PROVIDER_FIELDS), providers, PROVIDER_FIELDS);
      console.log(`  Providers: ${providers.length}`);
    } else {
      console.log(`Loading shard providers from ${providersFlag}...`);
      const shardProvidersRaw: Record<string, { provider: Provider; organization: Organization | null }> =
        JSON.parse(readFileSync(resolve(providersFlag!), 'utf-8'));

      const provResult = await conn.query('MATCH (p:Provider) RETURN p.provider_id AS id') as unknown as { getAll(): Promise<{ id: string }[]> };
      const existingProviders = new Set<string>((await provResult.getAll()).map((r) => r.id));
      const orgResult = await conn.query('MATCH (o:Organization) RETURN o.organization_id AS id') as unknown as { getAll(): Promise<{ id: string }[]> };
      const existingOrgs = new Set<string>((await orgResult.getAll()).map((r) => r.id));

      const newOrgMap = new Map<string, Organization>();
      for (const entry of Object.values(shardProvidersRaw)) {
        if (!existingProviders.has(entry.provider.id)) {
          providers.push(entry.provider);
        }
        const org = entry.organization;
        if (org && !existingOrgs.has(org.id) && !newOrgMap.has(org.id)) {
          newOrgMap.set(org.id, org);
        }
      }
      organizations = [...newOrgMap.values()];

      writeCsvFromArray(orgFile, Object.values(ORGANIZATION_FIELDS), organizations, ORGANIZATION_FIELDS);
      writeCsvFromArray(provFile, Object.values(PROVIDER_FIELDS), providers, PROVIDER_FIELDS);
      const affLines = ['provider_id,organization_id'];
      for (const p of providers) {
        if (p.organizationId) affLines.push([p.id, p.organizationId].map(escapeCsv).join(','));
      }
      writeFileSync(affiliatedFile, affLines.join('\n'), 'utf-8');
      console.log(`  New organizations: ${organizations.length} (${existingOrgs.size} already loaded)`);
      console.log(`  New providers: ${providers.length} (${existingProviders.size} already loaded)`);
    }

    // ── 2. Stream source JSON → concept maps + relationship CSVs ──────

    console.log(`Streaming ${SOURCE_PATH}...`);

    // Concept collectors (keyed by code)
    const conceptConditions = new Map<string, ConceptCondition>();
    const conceptMedications = new Map<string, ConceptMedication>();
    const conceptObservations = new Map<string, ConceptObservation>();
    const conceptProcedures = new Map<string, ConceptProcedure>();

    // Cross-concept reason code mappings
    const medTreats = new Map<string, Set<string>>();     // med code → Set<condition code>
    const procIndicatedBy = new Map<string, Set<string>>(); // proc code → Set<condition code>

    // Patient CSV writer. Column order mirrors the Patient NODE TABLE schema.
    const patWriter = createWriteStream(join(TMP_DIR, 'patients.csv'), 'utf-8');
    const PATIENT_CSV_COLS = [
      'patient_id', 'first_name', 'last_name', 'birth_date', 'death_date', 'age_years',
      'gender', 'race', 'ethnicity', 'marital_status', 'city', 'state', 'zip',
    ];
    writeCsvHeader(patWriter, PATIENT_CSV_COLS);
    const ingestDateIso = asOfFlag ?? new Date().toISOString().slice(0, 10);
    if (asOfFlag) console.log(`  age_years reference date pinned to ${asOfFlag}`);

    function yearsBetween(birthIso: string, asOfIso: string): number | '' {
      if (!birthIso) return '';
      const b = new Date(birthIso);
      const a = new Date(asOfIso);
      if (Number.isNaN(b.getTime()) || Number.isNaN(a.getTime())) return '';
      let years = a.getUTCFullYear() - b.getUTCFullYear();
      const monthDiff = a.getUTCMonth() - b.getUTCMonth();
      const dayDiff = a.getUTCDate() - b.getUTCDate();
      if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) years--;
      return years;
    }

    // Encounter CSV writer
    const encWriter = createWriteStream(join(TMP_DIR, 'encounters.csv'), 'utf-8');
    writeCsvHeader(encWriter, Object.values(ENCOUNTER_FIELDS));

    // Relationship CSVs (FROM key, TO key, properties)
    const diagWriter = createWriteStream(join(TMP_DIR, 'diagnosed_with.csv'), 'utf-8');
    writeCsvHeader(diagWriter, ['patient_id', 'code', 'start_date', 'stop_date', 'encounter_id']);

    const prescWriter = createWriteStream(join(TMP_DIR, 'prescribed.csv'), 'utf-8');
    writeCsvHeader(prescWriter, ['patient_id', 'code', 'start_date', 'stop_date', 'encounter_id', 'reason_code', 'reason_description']);

    const resultWriter = createWriteStream(join(TMP_DIR, 'has_result.csv'), 'utf-8');
    writeCsvHeader(resultWriter, ['patient_id', 'code', 'value', 'units', 'value_canonical', 'units_canonical', 'date', 'encounter_id', 'category', 'type']);

    const underwentWriter = createWriteStream(join(TMP_DIR, 'underwent.csv'), 'utf-8');
    writeCsvHeader(underwentWriter, ['patient_id', 'code', 'start_date', 'stop_date', 'encounter_id', 'reason_code', 'reason_description']);

    const hadEncWriter = createWriteStream(join(TMP_DIR, 'had_encounter.csv'), 'utf-8');
    writeCsvHeader(hadEncWriter, ['patient_id', 'encounter_id']);

    const treatedByWriter = createWriteStream(join(TMP_DIR, 'treated_by.csv'), 'utf-8');
    writeCsvHeader(treatedByWriter, ['encounter_id', 'provider_id']);

    const atOrgWriter = createWriteStream(join(TMP_DIR, 'at_organization.csv'), 'utf-8');
    writeCsvHeader(atOrgWriter, ['encounter_id', 'organization_id']);

    const reasonForWriter = createWriteStream(join(TMP_DIR, 'reason_for.csv'), 'utf-8');
    writeCsvHeader(reasonForWriter, ['encounter_id', 'code']);

    // Deferred: encounter reason codes (written after stream when all conditions are known)
    const encounterReasons: [string, string][] = [];

    let patientCount = 0;
    let condCount = 0, medCount = 0, obsCount = 0, procCount = 0, encCount = 0;

    await pipeline(
      createReadStream(SOURCE_PATH),
      parser(),
      streamObject(),
      new Transform({
        objectMode: true,
        transform(chunk: { key: string; value: unknown }, _encoding, callback) {
          const entry = chunk.value as {
            patient: Patient;
            encounters: Encounter[];
            conditions: Condition[];
            medications: Medication[];
            observations: Observation[];
            procedures: Procedure[];
          };

          const pid = entry.patient.id;

          // Tier filter: skip patients not in the allowlist (and all their records).
          // This is the only place we apply the filter — by skipping early we ensure
          // no orphan encounters/conditions/etc reference patients that won't exist.
          if (tierAllowlist && !tierAllowlist.has(pid)) {
            callback();
            return;
          }

          // Patient node. age_years computed as of ingest date (or at death, if
          // the patient is deceased) so cohort age filters run without date math.
          const pRow = mapOne(entry.patient as unknown as Record<string, unknown>, PATIENT_FIELDS);
          const birth = String(pRow.birth_date ?? '');
          const death = String(pRow.death_date ?? '');
          const referenceForAge = death && death < ingestDateIso ? death : ingestDateIso;
          pRow.age_years = yearsBetween(birth, referenceForAge);
          patWriter.write(toCsvLine(PATIENT_CSV_COLS, pRow) + '\n');

          // Encounters
          for (const e of entry.encounters) {
            const eRow = mapOne(e as unknown as Record<string, unknown>, ENCOUNTER_FIELDS);
            encWriter.write(toCsvLine(Object.values(ENCOUNTER_FIELDS), eRow) + '\n');
            encCount++;

            // HAD_ENCOUNTER relationship
            writeCsvLine(hadEncWriter, [pid, e.id]);

            // TREATED_BY
            if (e.providerId) writeCsvLine(treatedByWriter, [e.id, e.providerId]);

            // AT_ORGANIZATION
            if (e.organizationId) writeCsvLine(atOrgWriter, [e.id, e.organizationId]);

            // REASON_FOR — collect for post-stream writing (conditions may not be seen yet)
            if (e.reasonCode) {
              encounterReasons.push([e.id, e.reasonCode]);
            }
          }

          // Conditions → concept + relationship
          for (const c of entry.conditions) {
            if (!knownConditions.has(c.code) && !conceptConditions.has(c.code)) {
              conceptConditions.set(c.code, { code: c.code, system: c.system || 'SNOMED-CT', description: c.description });
            }
            writeCsvLine(diagWriter, [pid, c.code, toDateString(c.startDate), toDateString(c.stopDate ?? ''), c.encounterId]);
            condCount++;
          }

          // Medications → concept + relationship + TREATS mapping
          for (const m of entry.medications) {
            if (!knownMedications.has(m.code) && !conceptMedications.has(m.code)) {
              conceptMedications.set(m.code, { code: m.code, description: m.description });
            }
            writeCsvLine(prescWriter, [pid, m.code, toDateString(m.startDate), toDateString(m.stopDate ?? ''), m.encounterId, m.reasonCode, m.reasonDescription]);
            medCount++;

            // Collect TREATS cross-concept mapping
            if (m.reasonCode) {
              if (!medTreats.has(m.code)) medTreats.set(m.code, new Set());
              medTreats.get(m.code)!.add(m.reasonCode);
            }
          }

          // Observations → concept + relationship, with unit normalization
          for (const o of entry.observations) {
            if (!knownObservations.has(o.code) && !conceptObservations.has(o.code)) {
              conceptObservations.set(o.code, {
                code: o.code, description: o.description,
                category: o.category, units: o.units, type: o.type,
              });
            }
            const norm = normalizeObservation(o.code, o.value, o.units);
            writeCsvLine(resultWriter, [
              pid, o.code, o.value, o.units,
              norm.valueCanonical ?? '',
              norm.unitCanonical ?? '',
              toDateString(o.date), o.encounterId, o.category, o.type,
            ]);
            obsCount++;
          }

          // Procedures → concept + relationship + INDICATED_BY mapping
          for (const p of entry.procedures) {
            if (!knownProcedures.has(p.code) && !conceptProcedures.has(p.code)) {
              conceptProcedures.set(p.code, { code: p.code, system: p.system || 'SNOMED-CT', description: p.description });
            }
            writeCsvLine(underwentWriter, [pid, p.code, toDateString(p.startDate), toDateString(p.stopDate ?? ''), p.encounterId, p.reasonCode, p.reasonDescription]);
            procCount++;

            // Collect INDICATED_BY cross-concept mapping
            if (p.reasonCode) {
              if (!procIndicatedBy.has(p.code)) procIndicatedBy.set(p.code, new Set());
              procIndicatedBy.get(p.code)!.add(p.reasonCode);
            }
          }

          patientCount++;
          if (patientCount % 500 === 0) {
            process.stdout.write(`\r  Streamed ${patientCount} patients...`);
          }
          callback();
        },
      }),
    );

    console.log(`\r  Streamed ${patientCount} patients total.`);
    console.log(`  Encounters: ${encCount}`);
    console.log(`  Conditions: ${condCount} (${conceptConditions.size} unique concepts)`);
    console.log(`  Medications: ${medCount} (${conceptMedications.size} unique concepts)`);
    console.log(`  Observations: ${obsCount} (${conceptObservations.size} unique concepts)`);
    console.log(`  Procedures: ${procCount} (${conceptProcedures.size} unique concepts)`);

    // Write deferred REASON_FOR CSV (encounter→condition, only for known condition codes).
    // Unresolvable reasons are kept in the state file and retried on later
    // shards / at finalize, when the missing condition concept may have arrived.
    const reasonCandidates: [string, string][] = [...state.pending_edges.reason_for, ...encounterReasons];
    const pendingReasons: [string, string][] = [];
    let reasonForCount = 0;
    for (const [encId, condCode] of reasonCandidates) {
      if (conceptConditions.has(condCode) || knownConditions.has(condCode)) {
        writeCsvLine(reasonForWriter, [encId, condCode]);
        reasonForCount++;
      } else {
        pendingReasons.push([encId, condCode]);
      }
    }
    state.pending_edges.reason_for = pendingReasons;
    console.log(`  REASON_FOR edges: ${reasonForCount} (of ${reasonCandidates.length} encounter reasons, ${pendingReasons.length} pending)`);

    // Close all writers
    for (const w of [patWriter, encWriter, diagWriter, prescWriter, resultWriter,
                     underwentWriter, hadEncWriter, treatedByWriter, atOrgWriter, reasonForWriter]) {
      w.end();
    }

    // ── 3. Write concept node CSVs ──────────────────────────────────────

    console.log('\nWriting concept node CSVs...');

    const ccFile = join(TMP_DIR, 'concept_conditions.csv');
    const ccLines = ['code,system,description'];
    for (const c of conceptConditions.values()) ccLines.push([c.code, c.system, c.description].map(escapeCsv).join(','));
    writeFileSync(ccFile, ccLines.join('\n'), 'utf-8');

    const cmFile = join(TMP_DIR, 'concept_medications.csv');
    const cmLines = ['code,description'];
    for (const m of conceptMedications.values()) cmLines.push([m.code, m.description].map(escapeCsv).join(','));
    writeFileSync(cmFile, cmLines.join('\n'), 'utf-8');

    const coFile = join(TMP_DIR, 'concept_observations.csv');
    const coLines = ['code,description,category,units,type,canonical_unit,normal_low,normal_high,critical_low,critical_high,range_source'];
    let rangesPopulated = 0;
    // Kuzu's CSV parser trims trailing empty fields. Force the row to keep its
    // full width by quoting empty fields and guaranteeing the last column has a
    // non-empty value ("synthea" when no curated range is available).
    const emptyQuoted = '""';
    for (const o of conceptObservations.values()) {
      const spec = LOINC_SPECS.find((s) => s.code === o.code);
      const range = getReferenceRange(o.code);
      if (range) rangesPopulated++;
      const row = [
        escapeCsv(o.code),
        escapeCsv(o.description),
        escapeCsv(o.category),
        escapeCsv(o.units),
        escapeCsv(o.type),
        spec?.conversion.canonicalUnit ? escapeCsv(spec.conversion.canonicalUnit) : emptyQuoted,
        range?.normalLow != null ? String(range.normalLow) : emptyQuoted,
        range?.normalHigh != null ? String(range.normalHigh) : emptyQuoted,
        range?.criticalLow != null ? String(range.criticalLow) : emptyQuoted,
        range?.criticalHigh != null ? String(range.criticalHigh) : emptyQuoted,
        range?.source ? escapeCsv(range.source) : escapeCsv("synthea"),
      ];
      coLines.push(row.join(','));
    }
    writeFileSync(coFile, coLines.join('\n'), 'utf-8');
    console.log(`  ConceptObservation reference ranges populated: ${rangesPopulated} / ${conceptObservations.size}`);

    const cpFile = join(TMP_DIR, 'concept_procedures.csv');
    const cpLines = ['code,system,description'];
    for (const p of conceptProcedures.values()) cpLines.push([p.code, p.system, p.description].map(escapeCsv).join(','));
    writeFileSync(cpFile, cpLines.join('\n'), 'utf-8');

    // Cross-concept CSVs. In append mode these edges are NOT written to the DB
    // (COPY would duplicate pairs already loaded); the observed pairs are
    // accumulated in the state file and resolved once at --finalize against the
    // cumulative concept set.
    const treatsFile = join(TMP_DIR, 'treats.csv');
    const indicatedByFile = join(TMP_DIR, 'indicated_by.csv');
    const complicationOfFile = join(TMP_DIR, 'complication_of.csv');

    const writtenTreats = new Set(state.written_edges.treats);
    const writtenIndicated = new Set(state.written_edges.indicated_by);
    const pendingTreats = new Set(state.pending_edges.treats);
    const pendingIndicated = new Set(state.pending_edges.indicated_by);

    if (appendMode) {
      for (const [medCode, condCodes] of medTreats) {
        for (const condCode of condCodes) {
          const key = `${medCode}|${condCode}`;
          if (!writtenTreats.has(key)) pendingTreats.add(key);
        }
      }
      for (const [procCode, condCodes] of procIndicatedBy) {
        for (const condCode of condCodes) {
          const key = `${procCode}|${condCode}`;
          if (!writtenIndicated.has(key)) pendingIndicated.add(key);
        }
      }
      state.pending_edges.treats = [...pendingTreats];
      state.pending_edges.indicated_by = [...pendingIndicated];
      console.log(`  Cross-concept edges deferred to finalize: ${pendingTreats.size} TREATS, ${pendingIndicated.size} INDICATED_BY pending`);
    } else {
      const treatsLines = ['med_code,cond_code'];
      for (const [medCode, condCodes] of medTreats) {
        for (const condCode of condCodes) {
          const key = `${medCode}|${condCode}`;
          if (conceptConditions.has(condCode)) {
            treatsLines.push([medCode, condCode].map(escapeCsv).join(','));
            writtenTreats.add(key);
          } else {
            pendingTreats.add(key);
          }
        }
      }
      writeFileSync(treatsFile, treatsLines.join('\n'), 'utf-8');
      console.log(`  TREATS edges: ${treatsLines.length - 1}`);

      const indicatedByLines = ['proc_code,cond_code'];
      for (const [procCode, condCodes] of procIndicatedBy) {
        for (const condCode of condCodes) {
          const key = `${procCode}|${condCode}`;
          if (conceptConditions.has(condCode)) {
            indicatedByLines.push([procCode, condCode].map(escapeCsv).join(','));
            writtenIndicated.add(key);
          } else {
            pendingIndicated.add(key);
          }
        }
      }
      writeFileSync(indicatedByFile, indicatedByLines.join('\n'), 'utf-8');
      console.log(`  INDICATED_BY edges: ${indicatedByLines.length - 1}`);

      // COMPLICATION_OF edges from the curated SNOMED-CT map. Previous versions
      // used a word-overlap heuristic (≥50% token overlap between child desc and
      // extracted "due to" phrase) — dropped in favor of hand-verified pairs that
      // actually match SNOMED hierarchy or disease-causation semantics.
      const complicationOfLines = ['complication_code,parent_code'];
      let complicationDropped = 0;
      for (const edge of COMPLICATION_EDGES) {
        // Both codes must exist as concepts in this tier's cohort
        if (!conceptConditions.has(edge.childCode) || !conceptConditions.has(edge.parentCode)) {
          complicationDropped++;
          continue;
        }
        complicationOfLines.push([edge.childCode, edge.parentCode].map(escapeCsv).join(','));
        state.written_edges.complication_of.push(`${edge.childCode}|${edge.parentCode}`);
      }
      writeFileSync(complicationOfFile, complicationOfLines.join('\n'), 'utf-8');
      console.log(`  COMPLICATION_OF edges: ${complicationOfLines.length - 1} (${complicationDropped} map entries skipped — parent/child not in cohort)`);

      state.pending_edges.treats = [...pendingTreats];
      state.pending_edges.indicated_by = [...pendingIndicated];
      state.written_edges.treats = [...writtenTreats];
      state.written_edges.indicated_by = [...writtenIndicated];
    }

    // Small delay to let file streams flush
    await new Promise((r) => setTimeout(r, 500));

    // ── 4. Create schema ────────────────────────────────────────────────

    await conn.query('LOAD EXTENSION fts');

    // FTS indexes block DROP TABLE on the node they reference — drop them first.
    // Also dropped in append mode: COPY into an FTS-indexed table is unsafe, so
    // appends always leave FTS teardown here and rebuilding to --finalize.
    await dropFtsIndexes(conn);

    if (appendMode) {
      console.log('\nAppend mode: existing schema retained.');
    } else {
    console.log('\nCreating schema...');

    // Drop everything — query all tables and drop them
    // First drop all relationship tables, then all node tables
    try {
      const tablesResult = await conn.query("CALL show_tables() RETURN name, type ORDER BY type DESC");
      const tables = await tablesResult.getAll() as { name: string; type: string }[];
      // Drop REL tables first, then NODE tables
      const relTables = tables.filter(t => t.type === 'REL');
      const nodeTables = tables.filter(t => t.type === 'NODE');
      for (const t of relTables) {
        try { await conn.query(`DROP TABLE ${t.name}`); } catch { /* skip */ }
      }
      for (const t of nodeTables) {
        try { await conn.query(`DROP TABLE ${t.name}`); } catch { /* skip */ }
      }
    } catch {
      // Fallback: try known table names
      const dropOrder = [
        'COMPLICATION_OF', 'TREATS', 'INDICATED_BY', 'REASON_FOR',
        'AFFILIATED_WITH', 'AT_ORGANIZATION', 'TREATED_BY',
        'HAD_ENCOUNTER', 'UNDERWENT', 'HAS_RESULT', 'PRESCRIBED', 'DIAGNOSED_WITH',
        'ORDERED_BY', 'PRESCRIBED_BY',
        'ENCOUNTER_PROCEDURE', 'ENCOUNTER_OBSERVATION', 'ENCOUNTER_MEDICATION',
        'ENCOUNTER_DIAGNOSIS', 'HAS_PROCEDURE', 'HAS_OBSERVATION', 'HAS_MEDICATION',
        'HAS_CONDITION', 'HAS_ENCOUNTER',
        'Procedure', 'Observation', 'Medication', 'Condition',
        'ConceptProcedure', 'ConceptObservation', 'ConceptMedication', 'ConceptCondition',
        'Encounter', 'Patient', 'Provider', 'Organization',
      ];
      for (const t of dropOrder) {
        try { await conn.query(`DROP TABLE ${t}`); } catch { /* skip */ }
      }
    }

    // Concept node tables
    await conn.query(`CREATE NODE TABLE ConceptCondition (
      code STRING, system STRING, description STRING, PRIMARY KEY (code)
    )`);
    await conn.query(`CREATE NODE TABLE ConceptMedication (
      code STRING, description STRING, PRIMARY KEY (code)
    )`);
    await conn.query(`CREATE NODE TABLE ConceptObservation (
      code STRING, description STRING, category STRING, units STRING, type STRING,
      canonical_unit STRING,
      normal_low DOUBLE, normal_high DOUBLE,
      critical_low DOUBLE, critical_high DOUBLE,
      range_source STRING,
      PRIMARY KEY (code)
    )`);
    await conn.query(`CREATE NODE TABLE ConceptProcedure (
      code STRING, system STRING, description STRING, PRIMARY KEY (code)
    )`);

    // Instance node tables
    await conn.query(`CREATE NODE TABLE Organization (
      organization_id STRING, name STRING, city STRING, state STRING, zip STRING, phone STRING,
      PRIMARY KEY (organization_id)
    )`);
    await conn.query(`CREATE NODE TABLE Provider (
      provider_id STRING, organization_id STRING, name STRING, gender STRING, specialty STRING,
      PRIMARY KEY (provider_id)
    )`);
    await conn.query(`CREATE NODE TABLE Patient (
      patient_id STRING, first_name STRING, last_name STRING,
      birth_date DATE, death_date DATE,
      age_years INT64,
      gender STRING, race STRING, ethnicity STRING, marital_status STRING,
      city STRING, state STRING, zip STRING,
      PRIMARY KEY (patient_id)
    )`);
    await conn.query(`CREATE NODE TABLE Encounter (
      encounter_id STRING, patient_id STRING, provider_id STRING, organization_id STRING,
      encounter_class STRING, code STRING, description STRING,
      start_date DATE, stop_date DATE, reason_code STRING, reason_description STRING,
      PRIMARY KEY (encounter_id)
    )`);

    // Relationship tables with properties. Dates are DATE (was STRING) — Kuzu
    // parses YYYY-MM-DD strings at COPY and treats empty CSV fields as NULL.
    // Tool-side, q() normalizes Date objects back to YYYY-MM-DD strings so the
    // API response shape is unchanged for consumers.
    await conn.query(`CREATE REL TABLE DIAGNOSED_WITH (
      FROM Patient TO ConceptCondition,
      start_date DATE, stop_date DATE, encounter_id STRING,
      MANY_MANY
    )`);
    await conn.query(`CREATE REL TABLE PRESCRIBED (
      FROM Patient TO ConceptMedication,
      start_date DATE, stop_date DATE, encounter_id STRING,
      reason_code STRING, reason_description STRING,
      MANY_MANY
    )`);
    await conn.query(`CREATE REL TABLE HAS_RESULT (
      FROM Patient TO ConceptObservation,
      value STRING, units STRING,
      value_canonical DOUBLE, units_canonical STRING,
      date DATE, encounter_id STRING,
      category STRING, type STRING,
      MANY_MANY
    )`);
    await conn.query(`CREATE REL TABLE UNDERWENT (
      FROM Patient TO ConceptProcedure,
      start_date DATE, stop_date DATE, encounter_id STRING,
      reason_code STRING, reason_description STRING,
      MANY_MANY
    )`);
    await conn.query('CREATE REL TABLE HAD_ENCOUNTER (FROM Patient TO Encounter, MANY_MANY)');
    await conn.query('CREATE REL TABLE TREATED_BY (FROM Encounter TO Provider, MANY_MANY)');
    await conn.query('CREATE REL TABLE AT_ORGANIZATION (FROM Encounter TO Organization, MANY_MANY)');
    await conn.query('CREATE REL TABLE AFFILIATED_WITH (FROM Provider TO Organization, MANY_MANY)');

    // Cross-concept relationship tables
    await conn.query('CREATE REL TABLE TREATS (FROM ConceptMedication TO ConceptCondition, MANY_MANY)');
    await conn.query('CREATE REL TABLE INDICATED_BY (FROM ConceptProcedure TO ConceptCondition, MANY_MANY)');
    await conn.query('CREATE REL TABLE REASON_FOR (FROM Encounter TO ConceptCondition, MANY_MANY)');
    await conn.query('CREATE REL TABLE COMPLICATION_OF (FROM ConceptCondition TO ConceptCondition, MANY_MANY)');

    console.log('Schema created.');
    }

    // ── 5. Bulk load ────────────────────────────────────────────────────

    console.log('\nBulk loading nodes...');
    const nodeLoads = [
      { table: 'ConceptCondition', file: ccFile, rows: conceptConditions.size },
      { table: 'ConceptMedication', file: cmFile, rows: conceptMedications.size },
      { table: 'ConceptObservation', file: coFile, rows: conceptObservations.size },
      { table: 'ConceptProcedure', file: cpFile, rows: conceptProcedures.size },
      { table: 'Organization', file: orgFile, rows: organizations.length },
      { table: 'Provider', file: provFile, rows: providers.length },
      { table: 'Patient', file: join(TMP_DIR, 'patients.csv'), rows: patientCount },
      { table: 'Encounter', file: join(TMP_DIR, 'encounters.csv'), rows: encCount },
    ];
    for (const { table, file, rows } of nodeLoads) {
      if (rows === 0) {
        console.log(`  ${table}: skipped (no new rows)`);
        continue;
      }
      const t0 = Date.now();
      await conn.query(`COPY ${table} FROM '${file}' (header=true)`);
      console.log(`  ${table}: ${Date.now() - t0}ms`);
    }

    console.log('\nBulk loading relationships...');
    const relLoads = [
      { table: 'DIAGNOSED_WITH', file: join(TMP_DIR, 'diagnosed_with.csv') },
      { table: 'PRESCRIBED', file: join(TMP_DIR, 'prescribed.csv') },
      { table: 'HAS_RESULT', file: join(TMP_DIR, 'has_result.csv') },
      { table: 'UNDERWENT', file: join(TMP_DIR, 'underwent.csv') },
      { table: 'HAD_ENCOUNTER', file: join(TMP_DIR, 'had_encounter.csv') },
      { table: 'TREATED_BY', file: join(TMP_DIR, 'treated_by.csv') },
      { table: 'AT_ORGANIZATION', file: join(TMP_DIR, 'at_organization.csv') },
      ...(appendMode ? [] : [
        { table: 'TREATS', file: treatsFile },
        { table: 'INDICATED_BY', file: indicatedByFile },
        { table: 'COMPLICATION_OF', file: complicationOfFile },
      ]),
      { table: 'REASON_FOR', file: join(TMP_DIR, 'reason_for.csv') },
    ];
    for (const { table, file } of relLoads) {
      const t0 = Date.now();
      await conn.query(`COPY ${table} FROM '${file}' (header=true)`);
      console.log(`  ${table}: ${Date.now() - t0}ms`);
    }

    if (!appendMode) {
      // AFFILIATED_WITH (provider→org) — built via Cypher join since providers have org IDs
      console.log('\nCreating AFFILIATED_WITH edges...');
      const affT0 = Date.now();
      await conn.query(`MATCH (prov:Provider), (org:Organization)
                        WHERE prov.organization_id = org.organization_id
                        CREATE (prov)-[:AFFILIATED_WITH]->(org)`);
      console.log(`  done in ${Date.now() - affT0}ms`);
    } else if (providers.length > 0) {
      console.log('\nCreating AFFILIATED_WITH edges for new providers...');
      await conn.query(`COPY AFFILIATED_WITH FROM '${affiliatedFile}' (header=true)`);
      console.log(`  ${providers.length} edges`);
    }

    // ── 6. FTS indexes ──────────────────────────────────────────────────

    if (appendMode || skipFts) {
      console.log('\nFTS indexes deferred (build them with --finalize).');
    } else {
      console.log('\nRebuilding FTS indexes...');
      await createFtsIndexes(conn);
      console.log('FTS indexes created.');
    }

    // ── 7. Cross-shard state + provenance manifest ──────────────────────

    state.concepts = {
      conditions: [...knownConditions, ...conceptConditions.keys()],
      medications: [...knownMedications, ...conceptMedications.keys()],
      observations: [...knownObservations, ...conceptObservations.keys()],
      procedures: [...knownProcedures, ...conceptProcedures.keys()],
    };
    state.totals.patients += patientCount;
    state.totals.encounters += encCount;
    state.totals.conditions += condCount;
    state.totals.medications += medCount;
    state.totals.observations += obsCount;
    state.totals.procedures += procCount;
    if (appendMode) {
      state.totals.providers += providers.length;
      state.totals.organizations += organizations.length;
    } else {
      state.totals.providers = providers.length;
      state.totals.organizations = organizations.length;
    }
    state.written_edges.reason_for += reasonForCount;
    state.shards.push({
      source: SOURCE_PATH,
      timestamp: new Date().toISOString(),
      patients: patientCount,
      encounters: encCount,
    });
    saveState(state);
    console.log(`\nIngest state saved: ${STATE_PATH}`);

    console.log('Writing provenance manifest...');

    // Git SHA (best-effort — tolerates missing git / detached worktree)
    let gitSha = "unknown";
    let gitDirty = false;
    try {
      gitSha = execSync("git rev-parse HEAD", { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      gitDirty = execSync("git status --porcelain", { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;
    } catch { /* not a git repo or git missing */ }

    // Source file metadata (Synthea version isn't embedded in the data, so we
    // record the file's mtime + size as a weaker fingerprint)
    const patientsStat = existsSync(SOURCE_PATH) ? statSync(SOURCE_PATH) : null;

    const manifest = {
      ingest_timestamp: new Date().toISOString(),
      tier: tierFlag ?? "full",
      mode: appendMode ? 'append' : 'full',
      db_path: DB_PATH,
      git: { sha: gitSha, dirty: gitDirty },
      source: {
        patients_json: SOURCE_PATH,
        patients_json_mtime: patientsStat?.mtime.toISOString() ?? null,
        patients_json_bytes: patientsStat?.size ?? null,
      },
      as_of_date: ingestDateIso,
      counts: {
        patients: state.totals.patients,
        encounters: state.totals.encounters,
        providers: state.totals.providers,
        organizations: state.totals.organizations,
        concept_conditions: state.concepts.conditions.length,
        concept_medications: state.concepts.medications.length,
        concept_observations: state.concepts.observations.length,
        concept_procedures: state.concepts.procedures.length,
        condition_instances: state.totals.conditions,
        medication_instances: state.totals.medications,
        observation_instances: state.totals.observations,
        procedure_instances: state.totals.procedures,
      },
      derived_edges: {
        treats: state.written_edges.treats.length,
        indicated_by: state.written_edges.indicated_by.length,
        complication_of: state.written_edges.complication_of.length,
        reason_for: state.written_edges.reason_for,
      },
      pending_edges: {
        treats: state.pending_edges.treats.length,
        indicated_by: state.pending_edges.indicated_by.length,
        reason_for: state.pending_edges.reason_for.length,
      },
      shards: state.shards.length,
      elapsed_seconds: (Date.now() - startTime) / 1000,
    };

    const manifestPath = join(GEN_DIR, tierFlag ? `manifest-${tierFlag}.json` : 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    console.log(`  Manifest: ${manifestPath}`);

    // Also store the manifest inline as a Metadata node in the DB so consumers
    // (MCP clients, eval runs) can read provenance without hitting the filesystem.
    try {
      await conn.query(`CREATE NODE TABLE Metadata (
        key STRING, value STRING, PRIMARY KEY (key)
      )`);
    } catch { /* may already exist from a previous run */ }
    const metaRows: [string, string][] = [
      ["ingest_timestamp", manifest.ingest_timestamp],
      ["tier", manifest.tier],
      ["git_sha", gitSha],
      ["git_dirty", String(gitDirty)],
      ["patient_count", String(state.totals.patients)],
      ["encounter_count", String(state.totals.encounters)],
      ["concept_count", String(state.concepts.conditions.length + state.concepts.medications.length + state.concepts.observations.length + state.concepts.procedures.length)],
      ["manifest_json", JSON.stringify(manifest)],
    ];
    for (const [key, value] of metaRows) {
      try {
        const prep = await conn.prepare(`MERGE (m:Metadata {key: $key}) SET m.value = $value`);
        await conn.execute(prep, { key, value });
      } catch { /* Kuzu MERGE syntax may differ — fall back to CREATE */
        try {
          const prep = await conn.prepare(`CREATE (m:Metadata {key: $key, value: $value})`);
          await conn.execute(prep, { key, value });
        } catch { /* dup key — acceptable */ }
      }
    }
    console.log('  Metadata node written.');

    // ── Done ────────────────────────────────────────────────────────────

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const conceptTotal = state.concepts.conditions.length + state.concepts.medications.length
      + state.concepts.observations.length + state.concepts.procedures.length;
    console.log(`\nIngestion complete in ${elapsed}s.`);
    console.log(`  Concept nodes: ${conceptTotal}`);
    console.log(`  Total nodes: ${conceptTotal + state.totals.patients + state.totals.encounters + state.totals.organizations + state.totals.providers}`);

  } finally {
    await conn.close();
    await db.close();

    if (existsSync(TMP_DIR)) {
      rmSync(TMP_DIR, { recursive: true });
      console.log('Cleaned up temporary CSV files.');
    }
  }
}

async function finalize() {
  console.log('Finalizing ingest: resolving deferred edges + building FTS...');
  const startTime = Date.now();

  const state = loadState();
  if (!state) {
    console.error(`--finalize requires the ingest state file at ${STATE_PATH}`);
    process.exit(1);
  }
  if (!existsSync(DB_PATH)) {
    console.error(`--finalize requires an existing DB at ${DB_PATH}`);
    process.exit(1);
  }

  mkdirSync(TMP_DIR, { recursive: true });
  const db = new kuzu.Database(DB_PATH);
  const conn = new kuzu.Connection(db);

  try {
    await conn.query('LOAD EXTENSION fts');
    await dropFtsIndexes(conn);

    const condSet = new Set(state.concepts.conditions);
    const medSet = new Set(state.concepts.medications);
    const procSet = new Set(state.concepts.procedures);

    async function flushPairs(
      label: string, table: string, header: string,
      pending: string[], written: string[],
      fromSet: Set<string>,
    ): Promise<{ written: string[]; pending: string[] }> {
      const writtenSet = new Set(written);
      const resolvable: string[] = [];
      const unresolved: string[] = [];
      for (const key of pending) {
        if (writtenSet.has(key)) continue;
        const [from, to] = key.split('|');
        if (fromSet.has(from) && condSet.has(to)) {
          resolvable.push(key);
        } else {
          unresolved.push(key);
        }
      }
      if (resolvable.length > 0) {
        const file = join(TMP_DIR, `finalize_${table.toLowerCase()}.csv`);
        const lines = [header];
        for (const key of resolvable) {
          const [from, to] = key.split('|');
          lines.push([from, to].map(escapeCsv).join(','));
        }
        writeFileSync(file, lines.join('\n'), 'utf-8');
        await conn.query(`COPY ${table} FROM '${file}' (header=true)`);
      }
      console.log(`  ${label}: ${resolvable.length} written, ${unresolved.length} unresolved (dropped)`);
      return { written: [...writtenSet, ...resolvable], pending: [] };
    }

    const treatsResult = await flushPairs('TREATS', 'TREATS', 'med_code,cond_code',
      state.pending_edges.treats, state.written_edges.treats, medSet);
    state.written_edges.treats = treatsResult.written;
    state.pending_edges.treats = treatsResult.pending;

    const indicatedResult = await flushPairs('INDICATED_BY', 'INDICATED_BY', 'proc_code,cond_code',
      state.pending_edges.indicated_by, state.written_edges.indicated_by, procSet);
    state.written_edges.indicated_by = indicatedResult.written;
    state.pending_edges.indicated_by = indicatedResult.pending;

    const writtenComplications = new Set(state.written_edges.complication_of);
    const newComplications: string[] = [];
    for (const edge of COMPLICATION_EDGES) {
      const key = `${edge.childCode}|${edge.parentCode}`;
      if (writtenComplications.has(key)) continue;
      if (condSet.has(edge.childCode) && condSet.has(edge.parentCode)) {
        newComplications.push(key);
      }
    }
    if (newComplications.length > 0) {
      const file = join(TMP_DIR, 'finalize_complication_of.csv');
      const lines = ['complication_code,parent_code'];
      for (const key of newComplications) {
        const [child, parent] = key.split('|');
        lines.push([child, parent].map(escapeCsv).join(','));
      }
      writeFileSync(file, lines.join('\n'), 'utf-8');
      await conn.query(`COPY COMPLICATION_OF FROM '${file}' (header=true)`);
      state.written_edges.complication_of.push(...newComplications);
    }
    console.log(`  COMPLICATION_OF: ${newComplications.length} new edges written (${state.written_edges.complication_of.length} total)`);

    const pendingReasons: [string, string][] = [];
    const resolvableReasons: [string, string][] = [];
    for (const [encId, condCode] of state.pending_edges.reason_for) {
      if (condSet.has(condCode)) {
        resolvableReasons.push([encId, condCode]);
      } else {
        pendingReasons.push([encId, condCode]);
      }
    }
    if (resolvableReasons.length > 0) {
      const file = join(TMP_DIR, 'finalize_reason_for.csv');
      const lines = ['encounter_id,code'];
      for (const [encId, condCode] of resolvableReasons) {
        lines.push([encId, condCode].map(escapeCsv).join(','));
      }
      writeFileSync(file, lines.join('\n'), 'utf-8');
      await conn.query(`COPY REASON_FOR FROM '${file}' (header=true)`);
      state.written_edges.reason_for += resolvableReasons.length;
    }
    state.pending_edges.reason_for = [];
    console.log(`  REASON_FOR: ${resolvableReasons.length} resolved, ${pendingReasons.length} unresolved (dropped)`);

    console.log('\nBuilding FTS indexes...');
    await createFtsIndexes(conn);
    console.log('FTS indexes created.');

    saveState(state);

    const manifestPath = join(GEN_DIR, tierFlag ? `manifest-${tierFlag}.json` : 'manifest.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      manifest.finalize_timestamp = new Date().toISOString();
      manifest.derived_edges = {
        treats: state.written_edges.treats.length,
        indicated_by: state.written_edges.indicated_by.length,
        complication_of: state.written_edges.complication_of.length,
        reason_for: state.written_edges.reason_for,
      };
      manifest.pending_edges = { treats: 0, indicated_by: 0, reason_for: 0 };
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
      console.log(`  Manifest updated: ${manifestPath}`);
    }

    const metaRows: [string, string][] = [
      ["finalize_timestamp", new Date().toISOString()],
      ["patient_count", String(state.totals.patients)],
      ["encounter_count", String(state.totals.encounters)],
      ["concept_count", String(state.concepts.conditions.length + state.concepts.medications.length + state.concepts.observations.length + state.concepts.procedures.length)],
    ];
    for (const [key, value] of metaRows) {
      try {
        const prep = await conn.prepare(`MERGE (m:Metadata {key: $key}) SET m.value = $value`);
        await conn.execute(prep, { key, value });
      } catch { /* Metadata table may not exist in pre-state DBs */ }
    }

    console.log(`\nFinalize complete in ${((Date.now() - startTime) / 1000).toFixed(1)}s.`);
    console.log(`  Cumulative: ${state.totals.patients} patients, ${state.totals.encounters} encounters, ${state.shards.length} shard(s)`);
  } finally {
    await conn.close();
    await db.close();
    if (existsSync(TMP_DIR)) {
      rmSync(TMP_DIR, { recursive: true });
    }
  }
}

const entry = finalizeMode ? finalize : ingest;
entry().catch((err) => {
  console.error('Ingestion failed:', err);
  process.exit(1);
});
