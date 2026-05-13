/**
 * Qwen (local Ollama) round-robin sweep. Mirrors scripts/round-robin-sweep.ts
 * with two differences:
 *   1. Systems run SEQUENTIALLY per question (Ollama can't handle 4 parallel
 *      tool-calling sessions against a single local model).
 *   2. Prioritizes questions that the Claude sweep already covered, so we
 *      get paired (Claude, Qwen) rows as early as possible. Any remaining
 *      questions then flow in round-robin order.
 *
 * Resumable — re-running picks up where a previous invocation stopped.
 *
 * Usage:
 *   npx tsx scripts/round-robin-sweep-qwen.ts                # 20 Qs, qwen2.5:32b, tier-200
 *   npx tsx scripts/round-robin-sweep-qwen.ts --limit 50
 *   npx tsx scripts/round-robin-sweep-qwen.ts --model llama3.1:8b
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { EvalQuestion, RunResult, ScoredResult } from '../src/eval/types.js';
import { runGraph, runSqlFts, runSqlT2S, runLlmOnly, runGraphCypher } from '../src/eval/runner.js';
import { score } from '../src/eval/scorer.js';

const PROJECT_ROOT = join(import.meta.dirname, '..');
const RESULTS_DIR = join(PROJECT_ROOT, 'results');

type System = 'graph' | 'sql-fts' | 'sql-t2s' | 'llm-only' | 'graph-cypher';
const SYSTEMS: System[] = ['graph', 'sql-fts', 'sql-t2s', 'llm-only', 'graph-cypher'];

// llm-only can't answer cohort questions at any realistic tier; the prompt
// would exceed the model's context window. Skip rather than timing out.
function applicableSystems(questionType: string): System[] {
  return SYSTEMS.filter((s) => !(s === 'llm-only' && questionType === 'cohort'));
}

// Per-type timeouts. Ollama tool-calling is much slower than Claude's MCP
// path; the ceilings here are roughly 2× the Claude script so a 32B model
// gets room without waiting forever on the long tail.
const PER_TYPE_TIMEOUT_MS: Record<string, number> = {
  'simple-lookup':  90_000,
  'cohort':        120_000,
  'unanswerable':  120_000,
  'temporal':      180_000,
  'multi-hop':     300_000,
  'reasoning':     480_000,
};
const DEFAULT_TIMEOUT_MS = 240_000;

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function runOne(
  system: System,
  q: EvalQuestion,
  pool: pg.Pool,
  model: string,
  timeoutMs: number,
): Promise<RunResult> {
  const abortController = new AbortController();
  let timeoutTimer: NodeJS.Timeout | undefined;
  try {
    const runPromise = (async () => {
      const runOpts = { signal: abortController.signal };
      switch (system) {
        case 'graph':        return runGraph(q, model, runOpts);
        case 'sql-fts':      return runSqlFts(q, pool, model, runOpts);
        case 'sql-t2s':      return runSqlT2S(q, pool, model, runOpts);
        case 'llm-only':     return runLlmOnly(q, model, runOpts);
        case 'graph-cypher': return runGraphCypher(q, model, runOpts);
      }
    })();
    const timeoutPromise = new Promise<RunResult>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        abortController.abort();
        reject(new Error(`Timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    return await Promise.race([runPromise, timeoutPromise]);
  } catch (err) {
    return {
      questionId: q.id,
      system,
      model,
      answer: '',
      latencyMs: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (!abortController.signal.aborted) abortController.abort();
  }
}

async function main() {
  if (process.env.BRAINIFAI_METRICS === undefined) {
    process.env.BRAINIFAI_METRICS = '1';
  }

  const args = process.argv.slice(2);
  let model = getArg(args, '--model') ?? 'qwen2.5:32b';
  const tier = getArg(args, '--tier') ?? '200';
  const limit = parseInt(getArg(args, '--limit') ?? '20');
  // --hosted: route open-source models through OpenRouter instead of local
  // Ollama. Auto-prefixes `openrouter/` so the provider registry picks the
  // OpenRouter branch. Requires OPENROUTER_API_KEY in env.
  const hosted = args.includes('--hosted');
  // By default prioritize the ids already covered by the Claude sweep so
  // early rows are paired (same question, Claude + Qwen). Pass --no-prioritize
  // to fall back to pure round-robin.
  const noPrioritize = args.includes('--no-prioritize');
  const claudePriorityFile = getArg(args, '--priority-file') ??
    join(RESULTS_DIR, `round-robin-claude-haiku-4-5-tier-${tier}.json`);

  if (!['200', '2000', '20000'].includes(tier)) {
    console.error(`Invalid --tier '${tier}'. Must be 200, 2000, or 20000.`);
    process.exit(1);
  }
  if (model.startsWith('claude-')) {
    console.error(`This script is for local Ollama / OpenRouter models. Use round-robin-sweep.ts for Claude.`);
    process.exit(1);
  }
  if (hosted) {
    if (!process.env.OPENROUTER_API_KEY) {
      console.error('--hosted requires OPENROUTER_API_KEY in env. Get a key at https://openrouter.ai and export it.');
      process.exit(1);
    }
    if (!model.startsWith('openrouter/')) model = `openrouter/${model}`;
  }

  process.env.KUZU_DB_PATH = join(PROJECT_ROOT, '.brainifai', 'data', `kuzu-${tier}`);
  process.env.PG_DSN = `postgresql://user@localhost:5432/ehrdb-${tier}`;
  process.env.BRAINIFAI_TIER = tier;

  const modelSlug = model.replace(/[:/]/g, '-');
  const OUT_FILE = join(RESULTS_DIR, `round-robin-${modelSlug}-tier-${tier}.json`);

  console.log(`Round-robin sweep (sequential per question — ${hosted ? 'OpenRouter' : 'Ollama'})`);
  console.log(`  model:   ${model}`);
  console.log(`  tier:    ${tier}`);
  console.log(`  limit:   ${limit} questions`);
  console.log(`  systems: ${SYSTEMS.join(', ')} (sequential)`);
  console.log(`  output:  ${OUT_FILE}`);

  // Load questions + swap tier-aware cohort GT.
  const questionsFile = join(PROJECT_ROOT, 'data', 'generated', 'evaluation-questions-tiered.json');
  let questions: EvalQuestion[] = JSON.parse(readFileSync(questionsFile, 'utf-8'));
  questions = questions.map((q) => {
    const gtByTier = (q as EvalQuestion & { groundTruthByTier?: Record<string, string> }).groundTruthByTier;
    if (q.type === 'cohort' && gtByTier && gtByTier[tier]) {
      return { ...q, answer: gtByTier[tier] };
    }
    return q;
  });

  // Bucket by type in file order.
  const types = [...new Set(questions.map((q) => q.type))];
  const buckets: Record<string, EvalQuestion[]> = {};
  for (const t of types) buckets[t] = questions.filter((q) => q.type === t);

  // Priority list: questions already answered by the Claude sweep. If that
  // file doesn't exist we fall through cleanly.
  let priorityIds: string[] = [];
  if (!noPrioritize && existsSync(claudePriorityFile)) {
    try {
      const claudeRows: ScoredResult[] = JSON.parse(readFileSync(claudePriorityFile, 'utf-8'));
      priorityIds = [...new Set(claudeRows.map((r) => r.questionId))];
      console.log(`  priority: ${priorityIds.length} question ids from ${claudePriorityFile}`);
    } catch (err) {
      console.warn(`  priority file unreadable (${(err as Error).message}); skipping prioritization`);
    }
  } else {
    console.log(`  priority: (none)`);
  }

  // Reorder buckets: priority-ids first within each bucket (in the order
  // they appear in the priority list), then the remaining questions in
  // their original file order. Round-robin still rotates across types.
  if (priorityIds.length > 0) {
    const prioritySet = new Set(priorityIds);
    for (const t of types) {
      const bucket = buckets[t];
      const inPriority = priorityIds
        .map((id) => bucket.find((q) => q.id === id))
        .filter((q): q is EvalQuestion => q !== undefined);
      const rest = bucket.filter((q) => !prioritySet.has(q.id));
      buckets[t] = [...inPriority, ...rest];
    }
  }
  console.log(`\nTypes (${types.length}): ${types.map((t) => `${t}=${buckets[t].length}`).join(', ')}\n`);

  // Resume.
  mkdirSync(RESULTS_DIR, { recursive: true });
  let allResults: ScoredResult[] = [];
  const completed = new Set<string>();
  if (existsSync(OUT_FILE)) {
    allResults = JSON.parse(readFileSync(OUT_FILE, 'utf-8')) as ScoredResult[];
    for (const r of allResults) completed.add(`${r.system}:${r.questionId}`);
    console.log(`Resume: ${allResults.length} prior cells loaded (${completed.size} unique pairs)\n`);
  }

  const pool = new pg.Pool({ connectionString: process.env.PG_DSN });

  let totalCostUsd = allResults.reduce((s, r) => s + (r.breakdown?.costUsd ?? 0), 0);

  let shuttingDown = false;
  const saveAndExit = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n\nSaving results before exit...');
    writeFileSync(OUT_FILE, JSON.stringify(allResults, null, 2));
    console.log(`Saved ${allResults.length} cells. Re-run the script to resume.`);
    await pool.end().catch(() => {});
    process.exit(code);
  };
  process.on('SIGINT', () => saveAndExit(0));
  process.on('SIGTERM', () => saveAndExit(0));

  const cursors: Record<string, number> = {};
  for (const t of types) cursors[t] = 0;

  let questionsRun = 0;
  let typeIdx = 0;

  try {
    while (questionsRun < limit) {
      let picked: EvalQuestion | null = null;
      let missing: System[] = [];
      for (let attempt = 0; attempt < types.length; attempt++) {
        const t = types[typeIdx];
        typeIdx = (typeIdx + 1) % types.length;
        const bucket = buckets[t];
        while (cursors[t] < bucket.length) {
          const cand = bucket[cursors[t]];
          const eligible = applicableSystems(cand.type);
          const remaining = eligible.filter((s) => !completed.has(`${s}:${cand.id}`));
          if (remaining.length === 0) {
            cursors[t]++;
            continue;
          }
          picked = cand;
          missing = remaining;
          cursors[t]++;
          break;
        }
        if (picked) break;
      }
      if (!picked) {
        console.log('\nAll buckets exhausted — nothing left to run.');
        break;
      }

      questionsRun++;
      const q = picked;
      const timeoutMs = PER_TYPE_TIMEOUT_MS[q.type] ?? DEFAULT_TIMEOUT_MS;
      console.log(`\n[${questionsRun}/${limit}] ${q.id} (${q.type})  systems: ${missing.join(', ')}`);
      console.log(`  Q: ${q.question.slice(0, 110)}${q.question.length > 110 ? '…' : ''}`);

      const started = Date.now();
      // SEQUENTIAL — one system at a time. Local Ollama can't cleanly share
      // a single model across 4 concurrent tool-calling loops.
      for (const s of missing) {
        const r = await runOne(s, q, pool, model, timeoutMs);
        const scored = score(q, r);
        allResults.push(scored);
        completed.add(`${r.system}:${q.id}`);
        if (scored.breakdown?.costUsd != null) totalCostUsd += scored.breakdown.costUsd;
        const status = scored.error
          ? `✗ ${scored.error.slice(0, 60)}`
          : `${(scored.score * 100).toFixed(0)}%`;
        const turns = scored.breakdown?.numTurns != null ? ` turns=${scored.breakdown.numTurns}` : '';
        const costStr = scored.breakdown?.costUsd != null
          ? ` $${scored.breakdown.costUsd.toFixed(4)}`
          : '';
        console.log(`    ${s.padEnd(10)} ${status.padEnd(20)} ${scored.latencyMs}ms${turns}${costStr}`);
        // Persist after every system — sequential runs can be long, we don't
        // want to lose three successful systems if the fourth crashes.
        writeFileSync(OUT_FILE, JSON.stringify(allResults, null, 2));
      }
      const wallMs = Date.now() - started;
      console.log(`  wall=${wallMs}ms`);
    }

    console.log('\n── Summary (all cells in file) ─────────────────────');
    for (const system of SYSTEMS) {
      const sys = allResults.filter((r) => r.system === system);
      const scores = sys.filter((r) => !r.error).map((r) => r.score);
      const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      const errs = sys.filter((r) => r.error).length;
      console.log(`  ${system.padEnd(10)} ${(avg * 100).toFixed(1)}% (${sys.length} cells, ${errs} errors)`);
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Sweep failed:', err);
  process.exit(1);
});
