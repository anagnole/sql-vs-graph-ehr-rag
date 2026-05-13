/**
 * Round-robin sweep: rotate through question types, running 4 systems in
 * parallel per question. Fixed to tier-200 + Claude Haiku by default.
 *
 * For each iteration, picks the next question from the next type bucket
 * (cycling across types), then launches graph / sql-fts / sql-t2s / llm-only
 * in parallel. Results append to an incremental file; reruns skip any
 * (questionId, system) pair already recorded, so you can stop and resume.
 *
 * Usage:
 *   npx tsx scripts/round-robin-sweep.ts                # 20 questions, Haiku, tier-200
 *   npx tsx scripts/round-robin-sweep.ts --limit 50
 *   npx tsx scripts/round-robin-sweep.ts --model claude-sonnet-4-6
 *   npx tsx scripts/round-robin-sweep.ts --tier 2000
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

// llm-only can't answer cohort questions at any realistic tier: loading every
// patient entry into a single prompt exceeds the model's context window and
// 100% timed out on the first tier-200 run. Skip it cleanly instead of
// burning timeouts per cell.
function applicableSystems(questionType: string): System[] {
  return SYSTEMS.filter((s) => !(s === 'llm-only' && questionType === 'cohort'));
}

// Mirrors run.ts per-type timeouts so reasoning/multi-hop get headroom.
const PER_TYPE_TIMEOUT_MS: Record<string, number> = {
  'simple-lookup':  45_000,
  'cohort':         60_000,
  'unanswerable':   60_000,
  'temporal':       90_000,
  'multi-hop':     150_000,
  'reasoning':     240_000,
};
const DEFAULT_TIMEOUT_MS = 120_000;

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
  const model = getArg(args, '--model') ?? 'claude-haiku-4-5';
  const tier = getArg(args, '--tier') ?? '200';
  const limit = parseInt(getArg(args, '--limit') ?? '20');

  if (!['200', '2000', '20000'].includes(tier)) {
    console.error(`Invalid --tier '${tier}'. Must be 200, 2000, or 20000.`);
    process.exit(1);
  }

  // Point MCP + pg at the tier-specific DBs. Must happen before any runner
  // touches kuzu-client or opens a pg pool. BRAINIFAI_TIER lets the prompt
  // builder pick the tier-sharded patients-tier-{N}.json if it exists,
  // so llm-only doesn't stream the full 7.3GB master snapshot.
  process.env.KUZU_DB_PATH = join(PROJECT_ROOT, '.brainifai', 'data', `kuzu-${tier}`);
  process.env.PG_DSN = `postgresql://user@localhost:5432/ehrdb-${tier}`;
  process.env.BRAINIFAI_TIER = tier;

  const modelSlug = model.replace(/[:/]/g, '-');
  const OUT_FILE = join(RESULTS_DIR, `round-robin-${modelSlug}-tier-${tier}.json`);

  console.log(`Round-robin sweep`);
  console.log(`  model:   ${model}`);
  console.log(`  tier:    ${tier}`);
  console.log(`  limit:   ${limit} questions`);
  console.log(`  systems: ${SYSTEMS.join(', ')} (parallel per question)`);
  console.log(`  output:  ${OUT_FILE}\n`);

  // Load questions and swap in tier-aware cohort GT (same logic as run.ts:152).
  const questionsFile = join(PROJECT_ROOT, 'data', 'generated', 'evaluation-questions-tiered.json');
  let questions: EvalQuestion[] = JSON.parse(readFileSync(questionsFile, 'utf-8'));
  questions = questions.map((q) => {
    const gtByTier = (q as EvalQuestion & { groundTruthByTier?: Record<string, string> }).groundTruthByTier;
    if (q.type === 'cohort' && gtByTier && gtByTier[tier]) {
      return { ...q, answer: gtByTier[tier] };
    }
    return q;
  });

  // Bucket by type, preserving the order already in the file (stable).
  const types = [...new Set(questions.map((q) => q.type))];
  const buckets: Record<string, EvalQuestion[]> = {};
  for (const t of types) buckets[t] = questions.filter((q) => q.type === t);
  console.log(`Types (${types.length}): ${types.map((t) => `${t}=${buckets[t].length}`).join(', ')}\n`);

  // Resume: read existing results file, index completed (qid, system) pairs.
  mkdirSync(RESULTS_DIR, { recursive: true });
  let allResults: ScoredResult[] = [];
  const completed = new Set<string>();
  if (existsSync(OUT_FILE)) {
    allResults = JSON.parse(readFileSync(OUT_FILE, 'utf-8')) as ScoredResult[];
    for (const r of allResults) completed.add(`${r.system}:${r.questionId}`);
    console.log(`Resume: ${allResults.length} prior cells loaded (${completed.size} unique pairs)\n`);
  }

  // pg pool for sql-fts + sql-t2s.
  const pool = new pg.Pool({ connectionString: process.env.PG_DSN });

  // Cumulative cost.
  let totalCostUsd = allResults.reduce((s, r) => s + (r.breakdown?.costUsd ?? 0), 0);

  // Graceful shutdown — save before exit.
  let shuttingDown = false;
  const saveAndExit = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n\nSaving results before exit...');
    writeFileSync(OUT_FILE, JSON.stringify(allResults, null, 2));
    console.log(`Saved ${allResults.length} cells. Total cost: $${totalCostUsd.toFixed(4)}. Re-run the script to resume.`);
    await pool.end().catch(() => {});
    process.exit(code);
  };
  process.on('SIGINT', () => saveAndExit(0));
  process.on('SIGTERM', () => saveAndExit(0));

  // Per-bucket cursors for round-robin iteration.
  const cursors: Record<string, number> = {};
  for (const t of types) cursors[t] = 0;

  let questionsRun = 0;
  let typeIdx = 0;

  try {
    // Stop when we've hit --limit OR every bucket is exhausted.
    while (questionsRun < limit) {
      // Try each type once before giving up — if all buckets are exhausted
      // at their current cursor, we're done.
      let picked: EvalQuestion | null = null;
      let missing: System[] = [];
      for (let attempt = 0; attempt < types.length; attempt++) {
        const t = types[typeIdx];
        typeIdx = (typeIdx + 1) % types.length;
        const bucket = buckets[t];
        // Advance this bucket's cursor past any already-fully-completed Qs.
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

      // Launch the missing systems in parallel. runOne catches its own errors
      // so one failing system doesn't sink the others.
      const started = Date.now();
      const results = await Promise.all(
        missing.map((s) => runOne(s, q, pool, model, timeoutMs)),
      );
      const wallMs = Date.now() - started;

      for (const r of results) {
        const scored = score(q, r);
        allResults.push(scored);
        completed.add(`${r.system}:${q.id}`);
        if (scored.breakdown?.costUsd != null) totalCostUsd += scored.breakdown.costUsd;
        const status = scored.error
          ? `✗ ${scored.error.slice(0, 60)}`
          : `${(scored.score * 100).toFixed(0)}%`;
        const costStr = scored.breakdown?.costUsd != null
          ? ` $${scored.breakdown.costUsd.toFixed(4)}`
          : '';
        const turns = scored.breakdown?.numTurns != null ? ` turns=${scored.breakdown.numTurns}` : '';
        console.log(`    ${r.system.padEnd(10)} ${status.padEnd(20)} ${scored.latencyMs}ms${turns}${costStr}`);
      }
      console.log(`  wall=${wallMs}ms  Σcost=$${totalCostUsd.toFixed(4)}`);

      // Persist after every question — cheap, and means Ctrl-C loses at most
      // the in-flight batch of 4.
      writeFileSync(OUT_FILE, JSON.stringify(allResults, null, 2));
    }

    // Final summary over this run's scope.
    console.log('\n── Summary (all cells in file) ─────────────────────');
    for (const system of SYSTEMS) {
      const sys = allResults.filter((r) => r.system === system);
      const scores = sys.filter((r) => !r.error).map((r) => r.score);
      const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      const errs = sys.filter((r) => r.error).length;
      console.log(`  ${system.padEnd(10)} ${(avg * 100).toFixed(1)}% (${sys.length} cells, ${errs} errors)`);
    }
    console.log(`\n  Total cost in file: $${totalCostUsd.toFixed(4)}`);
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Sweep failed:', err);
  process.exit(1);
});
