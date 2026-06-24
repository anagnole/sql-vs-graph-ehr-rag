import { writeFileSync, existsSync, createReadStream, createWriteStream, statSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parser } = require("stream-json");
const { streamObject } = require("stream-json/streamers/StreamObject");

const PROJECT_ROOT = join(import.meta.dirname, "..");
const GEN_DIR = join(PROJECT_ROOT, "data", "generated");
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBED_MODEL = "nomic-embed-text";
const BATCH_SIZE = 64;

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const tier = argValue("--tier");
if (!tier) {
  console.error("Usage: tsx scripts/build-dense-index.ts --tier <200|2000|20000> [--meta-only]");
  process.exit(1);
}
const metaOnly = process.argv.includes("--meta-only");

interface PatientEntry {
  patient: {
    id: string; firstName: string; lastName: string; birthDate: string;
    deathDate: string | null; gender: string; race: string; city: string; state: string;
  };
  encounters: Array<{ encounterClass: string; description: string; startDate: string; reasonDescription: string }>;
  conditions: Array<{ description: string; startDate: string; stopDate: string | null }>;
  medications: Array<{ description: string; startDate: string; stopDate: string | null; reasonDescription: string }>;
  observations: Array<{ description: string; value: string; units: string; date: string; category: string }>;
  procedures: Array<{ description: string; startDate: string; reasonDescription: string }>;
}

interface Chunk { patientId: string; section: string; text: string }

function batched<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function chunkPatient(entry: PatientEntry): Chunk[] {
  const p = entry.patient;
  const pid = p.id;
  const chunks: Chunk[] = [];

  chunks.push({
    patientId: pid,
    section: "demographics",
    text: `Patient demographics: ${p.firstName} ${p.lastName}, born ${p.birthDate}${p.deathDate ? `, died ${p.deathDate}` : ""}, gender ${p.gender}, race ${p.race}, lives in ${p.city}, ${p.state}.`,
  });

  const condLines = entry.conditions.map((c) =>
    `${c.description} (from ${c.startDate}${c.stopDate ? ` to ${c.stopDate}` : ", active"})`);
  for (const [i, group] of batched(condLines, 20).entries()) {
    chunks.push({ patientId: pid, section: `conditions-${i}`, text: `Conditions and diagnoses: ${group.join("; ")}` });
  }

  const medLines = entry.medications.map((m) =>
    `${m.description} (from ${m.startDate}${m.stopDate ? ` to ${m.stopDate}` : ", active"}${m.reasonDescription ? `, for ${m.reasonDescription}` : ""})`);
  for (const [i, group] of batched(medLines, 20).entries()) {
    chunks.push({ patientId: pid, section: `medications-${i}`, text: `Medications: ${group.join("; ")}` });
  }

  const byCode = new Map<string, PatientEntry["observations"]>();
  for (const o of entry.observations) {
    const arr = byCode.get(o.description) ?? [];
    arr.push(o);
    byCode.set(o.description, arr);
  }
  const obsLines: string[] = [];
  for (const [desc, obs] of byCode) {
    const sorted = obs.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5);
    obsLines.push(`${desc}: ${sorted.map((o) => `${o.value} ${o.units} on ${String(o.date).slice(0, 10)}`).join(", ")}`);
  }
  for (const [i, group] of batched(obsLines, 10).entries()) {
    chunks.push({ patientId: pid, section: `observations-${i}`, text: `Observations and lab results (most recent values): ${group.join(". ")}` });
  }

  const procLines = entry.procedures.map((pr) =>
    `${pr.description} on ${String(pr.startDate).slice(0, 10)}${pr.reasonDescription ? ` for ${pr.reasonDescription}` : ""}`);
  for (const [i, group] of batched(procLines, 20).entries()) {
    chunks.push({ patientId: pid, section: `procedures-${i}`, text: `Procedures: ${group.join("; ")}` });
  }

  const encLines = entry.encounters.map((e) =>
    `${e.encounterClass} encounter on ${String(e.startDate).slice(0, 10)}: ${e.description}${e.reasonDescription ? ` (reason: ${e.reasonDescription})` : ""}`);
  for (const [i, group] of batched(encLines, 15).entries()) {
    chunks.push({ patientId: pid, section: `encounters-${i}`, text: `Encounters: ${group.join("; ")}` });
  }

  return chunks;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts.map((t) => `search_document: ${t}`) }),
  });
  if (!res.ok) throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { embeddings: number[][] };
  return data.embeddings;
}

async function main() {
  const sourcePath = existsSync(join(GEN_DIR, `patients-tier-${tier}.json`))
    ? join(GEN_DIR, `patients-tier-${tier}.json`)
    : join(GEN_DIR, "patients.json");
  console.log(`Streaming ${sourcePath}...`);
  const allChunks: Chunk[] = [];
  let patientCount = 0;
  await pipeline(
    createReadStream(sourcePath),
    parser(),
    streamObject(),
    new Transform({
      objectMode: true,
      transform(chunk: { key: string; value: PatientEntry }, _enc, cb) {
        allChunks.push(...chunkPatient(chunk.value));
        patientCount++;
        cb();
      },
    }),
  );
  console.log(`${patientCount} patients → ${allChunks.length} chunks`);

  if (metaOnly) {
    const f32Path = join(GEN_DIR, `dense-index-${tier}.f32`);
    if (!existsSync(f32Path)) {
      throw new Error(`--meta-only needs an existing ${f32Path}`);
    }
    const dim = statSync(f32Path).size / 4 / allChunks.length;
    if (!Number.isInteger(dim)) {
      throw new Error(`f32 size does not divide evenly by chunk count (${allChunks.length}); chunk order may differ from the built index`);
    }
    await writeMeta(tier, dim, allChunks);
    console.log(`Rewrote meta for ${tier}: ${allChunks.length} chunks, dim ${dim} (f32 left untouched)`);
    return;
  }

  const vectors: number[][] = [];
  const t0 = Date.now();
  const batches = batched(allChunks, BATCH_SIZE);
  for (const [i, batch] of batches.entries()) {
    vectors.push(...await embedBatch(batch.map((c) => c.text)));
    if ((i + 1) % 10 === 0 || i === batches.length - 1) {
      const rate = vectors.length / ((Date.now() - t0) / 1000);
      process.stdout.write(`\r  embedded ${vectors.length}/${allChunks.length} (${rate.toFixed(0)}/s)`);
    }
  }
  console.log();

  const dim = vectors[0].length;
  const flat = new Float32Array(vectors.length * dim);
  for (const [i, v] of vectors.entries()) {
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < dim; j++) flat[i * dim + j] = v[j] / norm;
  }

  writeFileSync(join(GEN_DIR, `dense-index-${tier}.f32`), Buffer.from(flat.buffer));
  await writeMeta(tier, dim, allChunks);
  console.log(`Wrote dense-index-${tier}.f32 (${(flat.byteLength / 1e6).toFixed(1)} MB) + meta (${allChunks.length} chunks, dim ${dim})`);
}

async function writeMeta(tier: string, dim: number, chunks: Chunk[]): Promise<void> {
  writeFileSync(
    join(GEN_DIR, `dense-index-${tier}.meta.json`),
    JSON.stringify({ model: EMBED_MODEL, dim, count: chunks.length, tier, built: new Date().toISOString() }),
  );
  const ws = createWriteStream(join(GEN_DIR, `dense-index-${tier}.chunks.jsonl`));
  const FLUSH = 2000;
  for (let i = 0; i < chunks.length; i += FLUSH) {
    const part = chunks.slice(i, i + FLUSH).map((c) => JSON.stringify(c)).join("\n") + "\n";
    if (!ws.write(part)) await new Promise((r) => ws.once("drain", r));
  }
  await new Promise<void>((res, rej) => ws.end((err: Error | null | undefined) => (err ? rej(err) : res())));
}

main().catch((err) => {
  console.error("Index build failed:", err);
  process.exit(1);
});
