/**
 * Prompt builder for the LLM-only baseline.
 *
 * Serializes a patient's full record into structured text that the LLM
 * can use to answer questions without any retrieval tools.
 *
 * For single-patient questions: full patient record (~8000 token cap).
 * For cohort questions: summary table of relevant patients.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const require = createRequire(import.meta.url);
const { parser } = require('stream-json');
const { streamObject } = require('stream-json/streamers/StreamObject');

const PROJECT_ROOT = join(import.meta.dirname, '../..');
const GEN_DIR = join(PROJECT_ROOT, 'data', 'generated');

// Resolve the patient snapshot path. If BRAINIFAI_TIER is set and the
// tier-sharded file exists (written by scripts/shard-patients-by-tier.ts),
// prefer it — at tier-200 that's ~70MB instead of the 7.3GB master.
// Falls back to patients.json for the untiered case and tier-20000.
function patientsFile(): string {
  const tier = process.env.BRAINIFAI_TIER;
  if (tier && tier !== '20000') {
    const shard = join(GEN_DIR, `patients-tier-${tier}.json`);
    if (existsSync(shard)) return shard;
  }
  return join(GEN_DIR, 'patients.json');
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface PatientEntry {
  patient: {
    id: string; firstName: string; lastName: string; birthDate: string;
    deathDate: string | null; gender: string; race: string; ethnicity: string;
    maritalStatus: string; city: string; state: string; zip: string;
  };
  encounters: Array<{
    id: string; encounterClass: string; description: string;
    startDate: string; stopDate: string; providerId: string;
    reasonDescription: string;
  }>;
  conditions: Array<{
    id: string; description: string; startDate: string;
    stopDate: string | null; code: string;
  }>;
  medications: Array<{
    id: string; description: string; startDate: string;
    stopDate: string | null; code: string; reasonDescription: string;
  }>;
  observations: Array<{
    id: string; description: string; value: string;
    units: string; date: string; code: string; category: string;
  }>;
  procedures: Array<{
    id: string; description: string; startDate: string;
    stopDate: string; code: string; reasonDescription: string;
  }>;
}

// ─── Rough token estimator (~4 chars per token) ──────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Single patient prompt ───────────────────────────────────────────────────

export function buildPatientPrompt(entry: PatientEntry, maxTokens = 7800): string {
  const { patient: p } = entry;
  const sections: string[] = [];

  // Demographics (always included)
  sections.push(`## Patient: ${p.firstName} ${p.lastName} (ID: ${p.id})
- Born: ${p.birthDate}${p.deathDate ? `, Died: ${p.deathDate}` : ''}
- Gender: ${p.gender}, Race: ${p.race}, Ethnicity: ${p.ethnicity}
- Marital status: ${p.maritalStatus}
- Location: ${p.city}, ${p.state} ${p.zip}`);

  // Active conditions
  const active = entry.conditions.filter(c => !c.stopDate);
  const resolved = entry.conditions.filter(c => c.stopDate);

  sections.push(`## Active Conditions (${active.length})
${active.map(c => `- ${c.description} (since ${c.startDate}, code: ${c.code})`).join('\n') || 'None'}`);

  if (resolved.length > 0) {
    sections.push(`## Resolved Conditions (${resolved.length})
${resolved.map(c => `- ${c.description} (${c.startDate} to ${c.stopDate}, code: ${c.code})`).join('\n')}`);
  }

  // Medications
  const activeMeds = entry.medications.filter(m => !m.stopDate);
  const pastMeds = entry.medications.filter(m => m.stopDate);

  sections.push(`## Active Medications (${activeMeds.length})
${activeMeds.map(m => `- ${m.description} (since ${m.startDate}${m.reasonDescription ? `, for: ${m.reasonDescription}` : ''})`).join('\n') || 'None'}`);

  if (pastMeds.length > 0) {
    // Limit past meds to keep within token budget
    const shown = pastMeds.slice(0, 20);
    sections.push(`## Past Medications (${pastMeds.length} total, showing ${shown.length})
${shown.map(m => `- ${m.description} (${m.startDate} to ${m.stopDate})`).join('\n')}`);
  }

  // Observations — labs + vitals + surveys + exams. Skip social-history
  // observations (employment status etc.) since they're not clinical signal
  // and they collide with the conditions filter we apply upstream.
  // Group by code, keep the 5 most recent readings per code so temporal
  // questions have enough history to see a trend.
  const CLINICAL_OBS_CATEGORIES = new Set([
    'laboratory', 'vital-signs', 'survey', 'exam', 'procedure', '',
  ]);
  const obsByCode = new Map<string, typeof entry.observations[0][]>();
  for (const o of entry.observations) {
    if (o.category && !CLINICAL_OBS_CATEGORIES.has(o.category)) continue;
    const arr = obsByCode.get(o.code) || [];
    arr.push(o);
    obsByCode.set(o.code, arr);
  }

  const obsLines: string[] = [];
  for (const [, obs] of obsByCode) {
    const sorted = obs.sort((a, b) => b.date.localeCompare(a.date));
    const recent = sorted.slice(0, 5);
    const latest = recent[0];
    const history = recent.length > 1
      ? ` [history: ${recent.slice(1).map(o => `${o.date.slice(0, 10)}=${o.value}`).join(', ')}]`
      : '';
    obsLines.push(`- ${latest.description}: ${latest.value} ${latest.units} (${latest.date.slice(0, 10)})${history}`);
  }
  sections.push(`## Observations (${obsByCode.size} types, up to 5 most recent readings each)
${obsLines.join('\n') || 'None'}`);

  // Encounters — most recent 20
  const sortedEnc = [...entry.encounters].sort((a, b) => b.startDate.localeCompare(a.startDate));
  const shownEnc = sortedEnc.slice(0, 20);
  sections.push(`## Recent Encounters (${shownEnc.length} of ${entry.encounters.length})
${shownEnc.map(e => `- ${e.startDate}: ${e.description} (${e.encounterClass})${e.reasonDescription ? ` — reason: ${e.reasonDescription}` : ''}`).join('\n')}`);

  // Procedures — most recent 15
  const sortedProc = [...entry.procedures].sort((a, b) => b.startDate.localeCompare(a.startDate));
  const shownProc = sortedProc.slice(0, 15);
  sections.push(`## Recent Procedures (${shownProc.length} of ${entry.procedures.length})
${shownProc.map(pr => `- ${pr.startDate}: ${pr.description}${pr.reasonDescription ? ` (for: ${pr.reasonDescription})` : ''}`).join('\n') || 'None'}`);

  // Assemble and truncate if needed
  let prompt = sections.join('\n\n');
  const tokens = estimateTokens(prompt);
  if (tokens > maxTokens) {
    // Truncate from the end, keeping demographics + conditions + meds
    const cutoff = maxTokens * 4; // chars
    prompt = prompt.slice(0, cutoff) + '\n\n[... truncated to fit token limit]';
  }

  return prompt;
}

// ─── Cohort prompt ───────────────────────────────────────────────────────────

export function buildCohortPrompt(entries: PatientEntry[], maxTokens = 11800): string {
  const lines: string[] = [
    `## Patient Cohort Summary (${entries.length} patients)\n`,
    'ID | Name | Born | Gender | Race | City | Active Conditions | Active Medications',
    '---|------|------|--------|------|------|-------------------|-------------------',
  ];

  for (const e of entries) {
    const p = e.patient;
    const activeConditions = e.conditions
      .filter(c => !c.stopDate)
      .map(c => c.description)
      .join('; ');
    const activeMeds = e.medications
      .filter(m => !m.stopDate)
      .map(m => m.description)
      .join('; ');

    lines.push(
      `${p.id} | ${p.firstName} ${p.lastName} | ${p.birthDate} | ${p.gender} | ${p.race} | ${p.city} | ${activeConditions || 'None'} | ${activeMeds || 'None'}`
    );

    // Check token budget
    if (estimateTokens(lines.join('\n')) > maxTokens) {
      lines.push(`\n[... truncated at ${entries.indexOf(e) + 1} of ${entries.length} patients]`);
      break;
    }
  }

  return lines.join('\n');
}

// ─── Load patient data ───────────────────────────────────────────────────────

interface LoadOpts { signal?: AbortSignal }

/** Load a single patient entry by ID. Respects opts.signal — aborting
 *  destroys the stream and rejects with an AbortError so the caller's
 *  `entries` arrays can be GC'd. */
export async function loadPatientEntry(patientId: string, opts?: LoadOpts): Promise<PatientEntry | null> {
  return new Promise((resolve, reject) => {
    let found: PatientEntry | null = null;

    const stream = createReadStream(patientsFile())
      .pipe(parser())
      .pipe(streamObject());

    const onAbort = () => {
      stream.destroy();
      reject(new Error('Aborted'));
    };
    if (opts?.signal) {
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    stream.on('data', (chunk: { key: string; value: PatientEntry }) => {
      if (chunk.key === patientId) {
        found = chunk.value;
        stream.destroy();
      }
    });

    const settle = () => {
      if (opts?.signal) opts.signal.removeEventListener('abort', onAbort);
    };
    stream.on('end', () => { settle(); resolve(found); });
    stream.on('close', () => { settle(); resolve(found); });
    stream.on('error', (err: Error) => {
      settle();
      if (found) resolve(found);
      else reject(err);
    });
  });
}

/** Load multiple patient entries. Respects opts.signal. */
export async function loadPatientEntries(patientIds: string[], opts?: LoadOpts): Promise<PatientEntry[]> {
  const idSet = new Set(patientIds);
  const results = new Map<string, PatientEntry>();

  return new Promise((resolve, reject) => {
    const stream = createReadStream(patientsFile())
      .pipe(parser())
      .pipe(streamObject());

    const onAbort = () => {
      stream.destroy();
      reject(new Error('Aborted'));
    };
    if (opts?.signal) {
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    stream.on('data', (chunk: { key: string; value: PatientEntry }) => {
      if (idSet.has(chunk.key)) {
        results.set(chunk.key, chunk.value);
        if (results.size === idSet.size) {
          stream.destroy();
        }
      }
    });

    const settle = () => {
      if (opts?.signal) opts.signal.removeEventListener('abort', onAbort);
    };
    stream.on('end', () => { settle(); resolve([...results.values()]); });
    stream.on('close', () => { settle(); resolve([...results.values()]); });
    stream.on('error', (err: Error) => {
      settle();
      if (results.size > 0) resolve([...results.values()]);
      else reject(err);
    });
  });
}

/** Load all patient entries for the active tier snapshot. Respects
 *  opts.signal — aborting stops the pipeline so the growing `entries`
 *  array is released rather than continuing to fill after a timeout. */
export async function loadAllPatientEntries(opts?: LoadOpts): Promise<PatientEntry[]> {
  const entries: PatientEntry[] = [];

  const readStream = createReadStream(patientsFile());
  const onAbort = () => readStream.destroy(new Error('Aborted'));
  if (opts?.signal) {
    if (opts.signal.aborted) {
      readStream.destroy();
      throw new Error('Aborted');
    }
    opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    await pipeline(
      readStream,
      parser(),
      streamObject(),
      new Transform({
        objectMode: true,
        transform(chunk: { key: string; value: PatientEntry }, _encoding, callback) {
          entries.push(chunk.value);
          callback();
        },
      }),
    );
  } finally {
    if (opts?.signal) opts.signal.removeEventListener('abort', onAbort);
  }

  return entries;
}
