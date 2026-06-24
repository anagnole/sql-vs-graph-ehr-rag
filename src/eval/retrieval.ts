import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_DIR = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

export interface DenseChunk { patientId: string; section: string; text: string }

interface DenseIndex {
  dim: number;
  vectors: Float32Array;
  chunks: DenseChunk[];
  byPatient: Map<string, number[]>;
}

let denseIndexCache: { tier: string; index: DenseIndex } | null = null;

function readJsonlChunks(path: string): DenseChunk[] {
  const buf = readFileSync(path);
  const chunks: DenseChunk[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      if (i > start) chunks.push(JSON.parse(buf.toString('utf8', start, i)) as DenseChunk);
      start = i + 1;
    }
  }
  if (start < buf.length) chunks.push(JSON.parse(buf.toString('utf8', start)) as DenseChunk);
  return chunks;
}

export function loadDenseIndex(): DenseIndex {
  const tier = process.env.BRAINIFAI_TIER ?? 'full';
  if (denseIndexCache?.tier === tier) return denseIndexCache.index;
  const metaPath = join(PROJECT_DIR, 'data', 'generated', `dense-index-${tier}.meta.json`);
  if (!existsSync(metaPath)) {
    throw new Error(`Dense index missing for tier ${tier} — run: npx tsx scripts/build-dense-index.ts --tier ${tier}`);
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { dim: number; count: number; chunks?: DenseChunk[] };
  const chunksPath = join(PROJECT_DIR, 'data', 'generated', `dense-index-${tier}.chunks.jsonl`);
  let chunks: DenseChunk[];
  if (meta.chunks) {
    chunks = meta.chunks;
  } else if (existsSync(chunksPath)) {
    chunks = readJsonlChunks(chunksPath);
  } else {
    throw new Error(`Dense index for tier ${tier} has no chunks (missing ${chunksPath})`);
  }
  const buf = readFileSync(join(PROJECT_DIR, 'data', 'generated', `dense-index-${tier}.f32`));
  const vectors = new Float32Array(buf.buffer, buf.byteOffset, meta.count * meta.dim);
  const byPatient = new Map<string, number[]>();
  chunks.forEach((c, i) => {
    const arr = byPatient.get(c.patientId);
    if (arr) arr.push(i);
    else byPatient.set(c.patientId, [i]);
  });
  const index: DenseIndex = { dim: meta.dim, vectors, chunks, byPatient };
  denseIndexCache = { tier, index };
  return index;
}

export async function embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array> {
  const res = await fetch(`${process.env.OLLAMA_URL ?? 'http://localhost:11434'}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', input: [`search_query: ${text}`] }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { embeddings: number[][] };
  const v = data.embeddings[0];
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Float32Array.from(v, (x) => x / norm);
}

function denseRankPatient(qv: Float32Array, patientId: string): number[] {
  const idx = loadDenseIndex();
  const candidates = idx.byPatient.get(patientId) ?? [];
  const scored = candidates.map((i) => {
    let dot = 0;
    const off = i * idx.dim;
    for (let j = 0; j < idx.dim; j++) dot += qv[j] * idx.vectors[off + j];
    return { i, score: dot };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ i }) => i);
}

export async function denseRetrieve(question: string, patientId: string, k: number, signal?: AbortSignal): Promise<DenseChunk[]> {
  const idx = loadDenseIndex();
  if ((idx.byPatient.get(patientId) ?? []).length === 0) return [];
  const qv = await embedQuery(question, signal);
  return denseRankPatient(qv, patientId).slice(0, k).map((i) => idx.chunks[i]);
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9.]+/).filter((t) => t.length > 1);
}

function bm25RankPatient(question: string, patientId: string): number[] {
  const idx = loadDenseIndex();
  const candidates = idx.byPatient.get(patientId) ?? [];
  if (candidates.length === 0) return [];
  const k1 = 1.2;
  const b = 0.75;
  const docs = candidates.map((i) => tokenize(idx.chunks[i].text));
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const d of docs) {
    for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const qTokens = [...new Set(tokenize(question))];
  const scored = candidates.map((ci, di) => {
    const d = docs[di];
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of qTokens) {
      const f = tf.get(t);
      if (!f) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log((docs.length - n + 0.5) / (n + 0.5) + 1);
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avgLen));
    }
    return { i: ci, score };
  });
  scored.sort((a, b2) => b2.score - a.score);
  return scored.map(({ i }) => i);
}

export function bm25Retrieve(question: string, patientId: string, k: number): DenseChunk[] {
  const idx = loadDenseIndex();
  return bm25RankPatient(question, patientId).slice(0, k).map((i) => idx.chunks[i]);
}

export async function hybridRetrieve(question: string, patientId: string, k: number, signal?: AbortSignal): Promise<DenseChunk[]> {
  const idx = loadDenseIndex();
  if ((idx.byPatient.get(patientId) ?? []).length === 0) return [];
  const qv = await embedQuery(question, signal);
  const denseRank = denseRankPatient(qv, patientId);
  const bm25Rank = bm25RankPatient(question, patientId);
  const rrfK = 60;
  const fused = new Map<number, number>();
  denseRank.forEach((i, r) => fused.set(i, (fused.get(i) ?? 0) + 1 / (rrfK + r + 1)));
  bm25Rank.forEach((i, r) => fused.set(i, (fused.get(i) ?? 0) + 1 / (rrfK + r + 1)));
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([i]) => idx.chunks[i]);
}
