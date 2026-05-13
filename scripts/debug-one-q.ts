import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { runGraph, runSql, runSqlFts, runSqlT2S, runLlmOnly } from '../src/eval/runner.js';
import type { EvalQuestion } from '../src/eval/types.js';

// Parse args — positional ordering kept for back-compat with existing scripts:
//   npx tsx scripts/debug-one-q.ts <qid> <model> [tier] [system] [--json]
const argv = process.argv.slice(2);
const jsonMode = argv.includes('--json');
const positional = argv.filter((a) => a !== '--json');

const targetId = positional[0] ?? 'SL-19';
const model = positional[1] ?? 'qwen2.5:32b';
const tier = positional[2] ?? '200';
const system = positional[3] ?? 'graph';

if (!['200', '2000', '20000'].includes(tier)) {
  console.error(`Invalid tier '${tier}'. Must be 200, 2000, or 20000.`);
  process.exit(1);
}
if (!['graph', 'sql', 'sql-fts', 'sql-t2s', 'llm-only'].includes(system)) {
  console.error(`Invalid system '${system}'. Must be graph, sql, sql-fts, sql-t2s, or llm-only.`);
  process.exit(1);
}

// In JSON mode suppress the per-tool OLLAMA_DEBUG chatter — it otherwise
// floods the parent's stderr. Callers can still set OLLAMA_DEBUG=1 externally
// to force it on.
if (!jsonMode) process.env.OLLAMA_DEBUG = process.env.OLLAMA_DEBUG ?? '1';
process.env.BRAINIFAI_METRICS = '1';
process.env.KUZU_DB_PATH = join(process.cwd(), '.brainifai', 'data', `kuzu-${tier}`);
process.env.PG_DSN = `postgresql://user@localhost:5432/ehrdb-${tier}`;

const qs: EvalQuestion[] = JSON.parse(
  readFileSync(join(process.cwd(), 'data/generated/evaluation-questions-tiered.json'), 'utf-8'),
);
const q = qs.find((x) => x.id === targetId);
if (!q) { console.error(`Question ${targetId} not found`); process.exit(1); }

// Swap in tier-specific cohort ground truth if present (mirrors run.ts).
const gtByTier = (q as EvalQuestion & { groundTruthByTier?: Record<string, string> }).groundTruthByTier;
if (q.type === 'cohort' && gtByTier && gtByTier[tier]) {
  q.answer = gtByTier[tier];
}

if (!jsonMode) {
  console.error(`[DEBUG] Running ${q.id} (${q.type}) — tier ${tier}, system ${system}, model ${model}`);
  console.error(`[DEBUG] Question: ${q.question}`);
  console.error(`[DEBUG] PatientIds: ${JSON.stringify(q.patientIds)}`);
  console.error(`[DEBUG] Expected: ${q.answer}\n`);
}

const needsPg = ['sql', 'sql-fts', 'sql-t2s'].includes(system);
const pool = needsPg ? new pg.Pool({ connectionString: process.env.PG_DSN }) : null;

try {
  let result;
  switch (system) {
    case 'graph':    result = await runGraph(q, model); break;
    case 'sql':      result = await runSql(q, pool!, model); break;
    case 'sql-fts':  result = await runSqlFts(q, pool!, model); break;
    case 'sql-t2s':  result = await runSqlT2S(q, pool!, model); break;
    case 'llm-only': result = await runLlmOnly(q, model); break;
    default: throw new Error(`Unhandled system: ${system}`);
  }

  if (jsonMode) {
    // One line of JSON to stdout — parent scripts can read it directly.
    const row = {
      qid: q.id,
      type: q.type,
      tier,
      system,
      model,
      expected: q.answer,
      answer: result.answer,
      latencyMs: result.latencyMs,
      toolCalls: result.breakdown?.toolCalls ?? null,
      kuzuMs: result.breakdown?.kuzuMs ?? null,
      costUsd: result.breakdown?.costUsd ?? null,
      error: result.error ?? null,
    };
    process.stdout.write(JSON.stringify(row) + '\n');
  } else {
    console.error(`\n[DEBUG] ANSWER: ${result.answer}`);
    console.error(`[DEBUG] Tool calls: ${result.breakdown?.toolCalls ?? '?'}, latency: ${result.latencyMs}ms`);
  }
} catch (err) {
  if (jsonMode) {
    process.stdout.write(JSON.stringify({
      qid: q.id,
      type: q.type,
      tier,
      system,
      model,
      expected: q.answer,
      answer: '',
      latencyMs: 0,
      error: (err as Error).message,
    }) + '\n');
  } else {
    throw err;
  }
} finally {
  if (pool) await pool.end();
}
