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
import { join } from 'node:path';
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
const tierFlag = (() => {
  const i = argv.indexOf('--tier');
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
})();

const DB_PATH = tierFlag
  ? join(PROJECT_ROOT, '.brainifai', 'data', `kuzu-${tierFlag}`)
  : join(PROJECT_ROOT, '.brainifai', 'data', 'kuzu');

const TMP_DIR = join(PROJECT_ROOT, tierFlag ? `.tmp-csv-${tierFlag}` : '.tmp-csv');

// Load patient allowlist if tier specified — patients not in this set are skipped
// during streaming, producing a Kuzu DB containing only the tier's cohort.
const tierAllowlist: Set<string> | null = (() => {
  if (!tierFlag) return null;
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
  console.log(`Tier mode: --tier ${tierFlag}`);
  console.log(`  DB path: ${DB_PATH}`);
  console.log(`  Allowlist: ${tierAllowlist!.size} patients`);
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

// ─── Main ingestion ─────────────────────────────────────────────────────────

async function ingest() {
  console.log('Starting EHR data ingestion (concept node model)...');
  const startTime = Date.now();

  // Ensure parent dir exists. Kuzu refuses to use a pre-created directory —
  // it wants to initialize the DB itself, so we only mkdir the parent.
  mkdirSync(join(DB_PATH, '..'), { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });

  const db = new kuzu.Database(DB_PATH);
  const conn = new kuzu.Connection(db);

  try {
    // ── 1. Providers & Organizations ─────────────────────────────────────

    console.log('Loading providers.json...');
    const providersRaw: Record<string, { provider: Provider; organization: Organization }> =
      JSON.parse(readFileSync(join(GEN_DIR, 'providers.json'), 'utf-8'));

    const providers: Provider[] = [];
    const orgMap = new Map<string, Organization>();
    for (const entry of Object.values(providersRaw)) {
      providers.push(entry.provider);
      if (!orgMap.has(entry.organization.id)) {
        orgMap.set(entry.organization.id, entry.organization);
      }
    }
    const organizations = [...orgMap.values()];

    const orgFile = join(TMP_DIR, 'organizations.csv');
    writeCsvFromArray(orgFile, Object.values(ORGANIZATION_FIELDS), organizations, ORGANIZATION_FIELDS);
    console.log(`  Organizations: ${organizations.length}`);

    const provFile = join(TMP_DIR, 'providers.csv');
    writeCsvFromArray(provFile, Object.values(PROVIDER_FIELDS), providers, PROVIDER_FIELDS);
    console.log(`  Providers: ${providers.length}`);

    // ── 2. Stream patients.json → concept maps + relationship CSVs ──────

    console.log('Streaming patients.json...');

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
    const ingestDateIso = new Date().toISOString().slice(0, 10);

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
      createReadStream(join(GEN_DIR, 'patients.json')),
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
            if (!conceptConditions.has(c.code)) {
              conceptConditions.set(c.code, { code: c.code, system: c.system || 'SNOMED-CT', description: c.description });
            }
            writeCsvLine(diagWriter, [pid, c.code, toDateString(c.startDate), toDateString(c.stopDate ?? ''), c.encounterId]);
            condCount++;
          }

          // Medications → concept + relationship + TREATS mapping
          for (const m of entry.medications) {
            if (!conceptMedications.has(m.code)) {
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
            if (!conceptObservations.has(o.code)) {
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
            if (!conceptProcedures.has(p.code)) {
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

    // Write deferred REASON_FOR CSV (encounter→condition, only for known condition codes)
    let reasonForCount = 0;
    for (const [encId, condCode] of encounterReasons) {
      if (conceptConditions.has(condCode)) {
        writeCsvLine(reasonForWriter, [encId, condCode]);
        reasonForCount++;
      }
    }
    console.log(`  REASON_FOR edges: ${reasonForCount} (of ${encounterReasons.length} encounter reasons)`);

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

    // Cross-concept CSVs
    const treatsFile = join(TMP_DIR, 'treats.csv');
    const treatsLines = ['med_code,cond_code'];
    for (const [medCode, condCodes] of medTreats) {
      for (const condCode of condCodes) {
        // Only include if both codes exist as concepts
        if (conceptConditions.has(condCode)) {
          treatsLines.push([medCode, condCode].map(escapeCsv).join(','));
        }
      }
    }
    writeFileSync(treatsFile, treatsLines.join('\n'), 'utf-8');
    console.log(`  TREATS edges: ${treatsLines.length - 1}`);

    const indicatedByFile = join(TMP_DIR, 'indicated_by.csv');
    const indicatedByLines = ['proc_code,cond_code'];
    for (const [procCode, condCodes] of procIndicatedBy) {
      for (const condCode of condCodes) {
        if (conceptConditions.has(condCode)) {
          indicatedByLines.push([procCode, condCode].map(escapeCsv).join(','));
        }
      }
    }
    writeFileSync(indicatedByFile, indicatedByLines.join('\n'), 'utf-8');
    console.log(`  INDICATED_BY edges: ${indicatedByLines.length - 1}`);

    // COMPLICATION_OF edges from the curated SNOMED-CT map. Previous versions
    // used a word-overlap heuristic (≥50% token overlap between child desc and
    // extracted "due to" phrase) — dropped in favor of hand-verified pairs that
    // actually match SNOMED hierarchy or disease-causation semantics.
    const complicationOfFile = join(TMP_DIR, 'complication_of.csv');
    const complicationOfLines = ['complication_code,parent_code'];
    let complicationDropped = 0;
    for (const edge of COMPLICATION_EDGES) {
      // Both codes must exist as concepts in this tier's cohort
      if (!conceptConditions.has(edge.childCode) || !conceptConditions.has(edge.parentCode)) {
        complicationDropped++;
        continue;
      }
      complicationOfLines.push([edge.childCode, edge.parentCode].map(escapeCsv).join(','));
    }
    writeFileSync(complicationOfFile, complicationOfLines.join('\n'), 'utf-8');
    console.log(`  COMPLICATION_OF edges: ${complicationOfLines.length - 1} (${complicationDropped} map entries skipped — parent/child not in cohort)`);

    // Small delay to let file streams flush
    await new Promise((r) => setTimeout(r, 500));

    // ── 4. Create schema ────────────────────────────────────────────────

    console.log('\nCreating schema...');
    await conn.query('LOAD EXTENSION fts');

    // FTS indexes block DROP TABLE on the node they reference — drop them first.
    // (The list mirrors the CREATE_FTS_INDEX calls at the end of ingest.)
    const ftsIndexesToDrop: [string, string][] = [
      ['Patient', 'patient_fts'],
      ['ConceptCondition', 'condition_fts'],
      ['ConceptMedication', 'medication_fts'],
      ['ConceptObservation', 'observation_fts'],
      ['ConceptProcedure', 'procedure_fts'],
      ['Provider', 'provider_fts'],
      ['Organization', 'organization_fts'],
    ];
    for (const [table, index] of ftsIndexesToDrop) {
      try {
        await conn.query(`CALL DROP_FTS_INDEX('${table}', '${index}')`);
      } catch { /* may not exist */ }
    }

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

    // ── 5. Bulk load ────────────────────────────────────────────────────

    console.log('\nBulk loading nodes...');
    const nodeLoads = [
      { table: 'ConceptCondition', file: ccFile },
      { table: 'ConceptMedication', file: cmFile },
      { table: 'ConceptObservation', file: coFile },
      { table: 'ConceptProcedure', file: cpFile },
      { table: 'Organization', file: orgFile },
      { table: 'Provider', file: provFile },
      { table: 'Patient', file: join(TMP_DIR, 'patients.csv') },
      { table: 'Encounter', file: join(TMP_DIR, 'encounters.csv') },
    ];
    for (const { table, file } of nodeLoads) {
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
      { table: 'TREATS', file: treatsFile },
      { table: 'INDICATED_BY', file: indicatedByFile },
      { table: 'REASON_FOR', file: join(TMP_DIR, 'reason_for.csv') },
      { table: 'COMPLICATION_OF', file: complicationOfFile },
    ];
    for (const { table, file } of relLoads) {
      const t0 = Date.now();
      await conn.query(`COPY ${table} FROM '${file}' (header=true)`);
      console.log(`  ${table}: ${Date.now() - t0}ms`);
    }

    // AFFILIATED_WITH (provider→org) — built via Cypher join since providers have org IDs
    console.log('\nCreating AFFILIATED_WITH edges...');
    const affT0 = Date.now();
    await conn.query(`MATCH (prov:Provider), (org:Organization)
                      WHERE prov.organization_id = org.organization_id
                      CREATE (prov)-[:AFFILIATED_WITH]->(org)`);
    console.log(`  done in ${Date.now() - affT0}ms`);

    // ── 6. FTS indexes ──────────────────────────────────────────────────

    console.log('\nRebuilding FTS indexes...');
    const ftsIndexes = [
      `CALL CREATE_FTS_INDEX('Patient', 'patient_fts', ['first_name', 'last_name', 'city'])`,
      `CALL CREATE_FTS_INDEX('ConceptCondition', 'condition_fts', ['description', 'code'])`,
      `CALL CREATE_FTS_INDEX('ConceptMedication', 'medication_fts', ['description', 'code'])`,
      `CALL CREATE_FTS_INDEX('ConceptObservation', 'observation_fts', ['description', 'code'])`,
      `CALL CREATE_FTS_INDEX('ConceptProcedure', 'procedure_fts', ['description', 'code'])`,
      `CALL CREATE_FTS_INDEX('Provider', 'provider_fts', ['name', 'specialty'])`,
      `CALL CREATE_FTS_INDEX('Organization', 'organization_fts', ['name', 'city'])`,
    ];
    for (const stmt of ftsIndexes) {
      try { await conn.query(stmt); } catch { /* may already exist */ }
    }
    console.log('FTS indexes created.');

    // ── 7. Provenance manifest ──────────────────────────────────────────

    console.log('\nWriting provenance manifest...');

    // Git SHA (best-effort — tolerates missing git / detached worktree)
    let gitSha = "unknown";
    let gitDirty = false;
    try {
      gitSha = execSync("git rev-parse HEAD", { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      gitDirty = execSync("git status --porcelain", { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;
    } catch { /* not a git repo or git missing */ }

    // Source file metadata (Synthea version isn't embedded in the data, so we
    // record the file's mtime + size as a weaker fingerprint)
    const patientsPath = join(GEN_DIR, 'patients.json');
    const patientsStat = existsSync(patientsPath) ? statSync(patientsPath) : null;

    const manifest = {
      ingest_timestamp: new Date().toISOString(),
      tier: tierFlag ?? "full",
      db_path: DB_PATH,
      git: { sha: gitSha, dirty: gitDirty },
      source: {
        patients_json: patientsPath,
        patients_json_mtime: patientsStat?.mtime.toISOString() ?? null,
        patients_json_bytes: patientsStat?.size ?? null,
      },
      counts: {
        patients: patientCount,
        encounters: encCount,
        providers: providers.length,
        organizations: organizations.length,
        concept_conditions: conceptConditions.size,
        concept_medications: conceptMedications.size,
        concept_observations: conceptObservations.size,
        concept_procedures: conceptProcedures.size,
        condition_instances: condCount,
        medication_instances: medCount,
        observation_instances: obsCount,
        procedure_instances: procCount,
      },
      derived_edges: {
        treats: treatsLines.length - 1,
        indicated_by: indicatedByLines.length - 1,
        complication_of: complicationOfLines.length - 1,
        reason_for: reasonForCount,
      },
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
      ["patient_count", String(patientCount)],
      ["encounter_count", String(encCount)],
      ["concept_count", String(conceptConditions.size + conceptMedications.size + conceptObservations.size + conceptProcedures.size)],
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
    console.log(`\nIngestion complete in ${elapsed}s.`);
    console.log(`  Concept nodes: ${conceptConditions.size + conceptMedications.size + conceptObservations.size + conceptProcedures.size}`);
    console.log(`  Total nodes: ${conceptConditions.size + conceptMedications.size + conceptObservations.size + conceptProcedures.size + patientCount + encCount + organizations.length + providers.length}`);

  } finally {
    await conn.close();
    await db.close();

    if (existsSync(TMP_DIR)) {
      rmSync(TMP_DIR, { recursive: true });
      console.log('Cleaned up temporary CSV files.');
    }
  }
}

ingest().catch((err) => {
  console.error('Ingestion failed:', err);
  process.exit(1);
});
