/**
 * Full evaluation run — orchestrates all 4 runners across 80 questions,
 * scores results, and generates reports.
 *
 * Usage:
 *   npm run eval                                  # run all systems with Claude
 *   npm run eval -- --model gemma3:27b            # run with Ollama model
 *   npm run eval -- --model gemma3:27b --system llm-only  # specific system + model
 *   npm run eval -- --system graph                # run only graph (Claude only)
 *   npm run eval -- --limit 5                     # first 5 questions only
 *   npm run eval -- --skip-type cohort            # skip cohort questions
 *   npm run eval -- --timeout 60000               # 60s per question timeout
 *   npm run eval -- --resume                      # load previous results, skip completed
 *   npm run eval -- --model qwen/qwen-2.5-72b-instruct --hosted  # via OpenRouter
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { EvalQuestion, RunResult, ScoredResult } from './types.js';
import { runGraph, runSql, runSqlFts,
  runRagDense, runSqlT2S, runLlmOnly, runGraphCypher } from './runner.js';
import { score } from './scorer.js';
import { generateReport } from './report.js';

const PROJECT_ROOT = join(import.meta.dirname, '../..');
const RESULTS_DIR = join(PROJECT_ROOT, 'results');
type System = 'graph' | 'sql' | 'sql-fts' | 'sql-t2s' | 'llm-only' | 'graph-cypher' | 'rag-dense';

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function main() {
  // Enable per-stage timing collection unless explicitly disabled.
  // metrics.ts reads this on every call so post-import flips work.
  if (process.env.BRAINIFAI_METRICS === undefined) {
    process.env.BRAINIFAI_METRICS = '1';
  }

  const args = process.argv.slice(2);
  const systemArg = getArg(args, '--system') as System | undefined;
  const limitArg = getArg(args, '--limit');
  const skipType = getArg(args, '--skip-type');
  const timeoutArg = getArg(args, '--timeout');
  const modelArg = getArg(args, '--model');
  const tierArg = getArg(args, '--tier');
  const resume = args.includes('--resume');
  // --retry-errors: keep successful results from the incremental file, re-run
  // only the questions that errored. Useful for iterating on a fix without
  // re-burning cost on the ~66% of questions that already worked. Implies
  // --resume semantics but rewrites the errored entries in place.
  const retryErrors = args.includes('--retry-errors');
  // --overwrite: required to intentionally replace a non-empty incremental file
  // when neither --resume nor --retry-errors is passed. Prevents silent data
  // loss when running a single --system against a file that already holds
  // other systems' results.
  const overwrite = args.includes('--overwrite');
  // --hosted: route open-source models through OpenRouter instead of local
  // Ollama. Auto-prefixes the model with "openrouter/" if not already prefixed,
  // so the user can say `--model qwen/qwen-2.5-72b-instruct --hosted` and the
  // registry routes it correctly. Requires OPENROUTER_API_KEY in env.
  const hosted = args.includes('--hosted');

  let model = modelArg ?? 'claude-sonnet-4-6';
  const limit = limitArg ? parseInt(limitArg) : undefined;
  // Per-type timeout ceilings — calibrated so reasoning/multi-hop have the
  // headroom they need while simple-lookup and cohort can fail fast. An
  // explicit --timeout flag overrides every type.
  const PER_TYPE_TIMEOUT_MS: Record<string, number> = {
    'simple-lookup':  45_000,
    'cohort':         60_000,
    'unanswerable':   60_000,
    'temporal':       90_000,
    'multi-hop':     150_000,
    'reasoning':     240_000,
  };
  const timeoutOverride = timeoutArg ? parseInt(timeoutArg) : null;
  const defaultTimeout = 120_000;
  const resolveTimeout = (qType: string) =>
    timeoutOverride ?? PER_TYPE_TIMEOUT_MS[qType] ?? defaultTimeout;
  const tier = tierArg ?? null;

  if (hosted) {
    if (!process.env.OPENROUTER_API_KEY) {
      console.error('--hosted requires OPENROUTER_API_KEY in env. Get a key at https://openrouter.ai and export it.');
      process.exit(1);
    }
    if (model.startsWith('claude-')) {
      console.error(`--hosted is for open-source models; Claude routes via CLI. Drop --hosted or pick a non-claude model.`);
      process.exit(1);
    }
    if (!model.startsWith('openrouter/')) {
      model = `openrouter/${model}`;
    }
  }

  // Tier mode: point MCP at the tier-specific Kuzu DB and use the tiered
  // question bank with cohort ground-truth-per-tier.
  if (tier) {
    const validTiers = ['200', '2000', '20000', '1M'];
    if (!validTiers.includes(tier)) {
      console.error(`Invalid --tier '${tier}'. Must be one of: ${validTiers.join(', ')}`);
      process.exit(1);
    }
    process.env.KUZU_DB_PATH = join(PROJECT_ROOT, '.brainifai', 'data', `kuzu-${tier}`);
    process.env.PG_DSN = `postgresql://user@localhost:5432/ehrdb-${tier}`;
    process.env.BRAINIFAI_TIER = tier;
    console.log(`Tier mode: ${tier} → KUZU_DB_PATH=${process.env.KUZU_DB_PATH}`);
    console.log(`            PG_DSN=${process.env.PG_DSN}`);
  }

  const isClaude = model.startsWith('claude-');
  const systems: System[] = systemArg ? [systemArg] : ['graph', 'sql', 'sql-fts', 'llm-only'];

  // Per-model + per-tier results file so runs don't overwrite each other
  const modelSlug = model.replace(/[:/]/g, '-');
  const tierSuffix = tier ? `-tier-${tier}` : '';
  const INCREMENTAL_FILE = join(RESULTS_DIR, `incremental-${modelSlug}${tierSuffix}.json`);

  // Guard against silent overwrite: if the incremental file already holds
  // results and we're not resuming or retrying errors, bail unless the caller
  // explicitly asked to overwrite.
  if (existsSync(INCREMENTAL_FILE) && !resume && !retryErrors && !overwrite) {
    const existing = JSON.parse(readFileSync(INCREMENTAL_FILE, 'utf-8')) as ScoredResult[];
    if (existing.length > 0) {
      const bySys: Record<string, number> = {};
      for (const r of existing) bySys[r.system] = (bySys[r.system] ?? 0) + 1;
      const summary = Object.entries(bySys).map(([s, n]) => `${s}=${n}`).join(', ');
      console.error(`\nRefusing to overwrite ${INCREMENTAL_FILE}`);
      console.error(`  It already holds ${existing.length} results (${summary}).`);
      console.error(`  Pass --resume to add to it, --retry-errors to re-run failures,`);
      console.error(`  or --overwrite to intentionally replace.\n`);
      process.exit(1);
    }
  }

  const routeLabel = isClaude
    ? 'Claude CLI + MCP'
    : hosted
      ? 'OpenRouter + OpenAI-format tools'
      : 'Ollama + native tools';
  console.log(`Model: ${model} (${routeLabel})\n`);

  // Load questions — tiered file when in tier mode, otherwise the legacy file
  const questionsFile = tier
    ? join(PROJECT_ROOT, 'data', 'generated', 'evaluation-questions-tiered.json')
    : join(PROJECT_ROOT, 'data', 'generated', 'evaluation-questions.json');
  let questions: EvalQuestion[] = JSON.parse(readFileSync(questionsFile, 'utf-8'));

  // For cohort questions in tier mode, swap in the tier-specific ground truth.
  // groundTruthByTier is computed by scripts/recompute-cohort-gt.ts.
  if (tier) {
    const before = questions.length;
    questions = questions.map((q) => {
      const gtByTier = (q as EvalQuestion & { groundTruthByTier?: Record<string, string> }).groundTruthByTier;
      if (q.type === 'cohort' && gtByTier && gtByTier[tier]) {
        return { ...q, answer: gtByTier[tier] };
      }
      return q;
    });
    const cohort = questions.filter((q) => q.type === 'cohort').length;
    console.log(`Loaded ${questions.length} questions (${cohort} cohort recomputed for tier ${tier})\n`);
  }

  if (skipType) {
    questions = questions.filter(q => q.type !== skipType);
  }

  // --sample N: pick N questions evenly across types (e.g. --sample 10 = 2 per type)
  const sampleArg = getArg(args, '--sample');
  let subset: EvalQuestion[];
  if (sampleArg) {
    const n = parseInt(sampleArg);
    const types = [...new Set(questions.map(q => q.type))];
    const perType = Math.max(1, Math.floor(n / types.length));
    subset = [];
    for (const type of types) {
      subset.push(...questions.filter(q => q.type === type).slice(0, perType));
    }
  } else {
    subset = limit ? questions.slice(0, limit) : questions;
  }

  // Load previous results if resuming
  mkdirSync(RESULTS_DIR, { recursive: true });
  let allResults: ScoredResult[] = [];
  const completed = new Set<string>();

  if ((resume || retryErrors) && existsSync(INCREMENTAL_FILE)) {
    const prev: ScoredResult[] = JSON.parse(readFileSync(INCREMENTAL_FILE, 'utf-8'));
    if (retryErrors) {
      // Drop errored entries; they will be re-run. Keep successes cached.
      allResults = prev.filter((r) => !r.error);
      const droppedCount = prev.length - allResults.length;
      console.log(`Retry-errors: loaded ${prev.length} previous results, keeping ${allResults.length} successes, re-running ${droppedCount} errored questions\n`);
    } else {
      allResults = prev;
      console.log(`Resuming: ${allResults.length} previous results loaded\n`);
    }
    for (const r of allResults) {
      completed.add(`${r.system}:${r.questionId}`);
    }
  }

  const totalRuns = subset.length * systems.length - completed.size;
  console.log(`Running evaluation: ${subset.length} questions × ${systems.length} systems = ${totalRuns} runs\n`);

  // Setup
  const PG_DSN = process.env.PG_DSN ?? 'postgresql://user@localhost:5432/ehrdb';
  let pool: pg.Pool | null = null;
  if (systems.includes('sql') || systems.includes('sql-fts') || systems.includes('sql-t2s') || systems.includes('rag-dense')) {
    pool = new pg.Pool({ connectionString: PG_DSN });
  }

  // Cumulative cost tracker — sums per-question costUsd across the run
  let totalCostUsd = allResults.reduce(
    (sum, r) => sum + (r.breakdown?.costUsd ?? 0),
    0,
  );

  // Handle graceful shutdown — save what we have
  let shuttingDown = false;
  const saveAndExit = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n\nSaving results before exit...');
    writeFileSync(INCREMENTAL_FILE, JSON.stringify(allResults, null, 2));
    generateReport(questions, allResults);
    console.log(`Saved ${allResults.length} results. Total cost so far: $${totalCostUsd.toFixed(4)}. Resume with --resume`);
    process.exit(0);
  };
  process.on('SIGINT', saveAndExit);
  process.on('SIGTERM', saveAndExit);

  try {
    for (const system of systems) {
      console.log(`\n── ${system} ${'─'.repeat(50 - system.length)}`);

      for (let i = 0; i < subset.length; i++) {
        const q = subset[i];
        const key = `${system}:${q.id}`;

        if (completed.has(key)) {
          const prev = allResults.find(r => r.system === system && r.questionId === q.id);
          console.log(`  [${i + 1}/${subset.length}] ${q.id} (${q.type})... skip (${(prev?.score ?? 0) * 100}% cached)`);
          continue;
        }

        process.stdout.write(`  [${i + 1}/${subset.length}] ${q.id} (${q.type})... `);

        let result: RunResult;
        const questionTimeout = resolveTimeout(q.type);
        const abortController = new AbortController();
        let timeoutTimer: NodeJS.Timeout | undefined;
        try {
          const runPromise = (async () => {
            const runOpts = { signal: abortController.signal };
            switch (system) {
              case 'graph': return runGraph(q, model, runOpts);
              case 'sql': return runSql(q, pool!, model, runOpts);
              case 'sql-fts': return runSqlFts(q, pool!, model, runOpts);
              case 'rag-dense': return runRagDense(q, pool!, model, runOpts);
              case 'sql-t2s': return runSqlT2S(q, pool!, model, runOpts);
              case 'graph-cypher': return runGraphCypher(q, model, runOpts);
              case 'llm-only': return runLlmOnly(q, model, runOpts);
            }
          })();

          const timeoutPromise = new Promise<RunResult>((_, reject) => {
            timeoutTimer = setTimeout(() => {
              // Abort the in-flight subprocess / fetch so we stop burning
              // tokens and free resources; the race rejects immediately.
              abortController.abort();
              reject(new Error(`Timeout after ${questionTimeout}ms`));
            }, questionTimeout);
          });

          result = await Promise.race([runPromise, timeoutPromise]);
        } catch (err) {
          result = {
            questionId: q.id,
            system,
            model,
            answer: '',
            latencyMs: 0,
            error: err instanceof Error ? err.message : String(err),
          };
        } finally {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          // Abort any still-pending work (no-op if already aborted). Keeps
          // us from leaking the listener or letting a late-finishing child
          // keep the signal alive for the next iteration.
          if (!abortController.signal.aborted) abortController.abort();
        }

        const scored = score(q, result);
        allResults.push(scored);
        completed.add(key);

        const status = scored.error ? `✗ ${scored.error.slice(0, 40)}` : `${(scored.score * 100).toFixed(0)}%`;
        const b = scored.breakdown;
        if (b?.costUsd != null) totalCostUsd += b.costUsd;
        const bd = b
          ? ` [kuzu=${b.kuzuMs ?? 0}ms/${b.kuzuCalls ?? 0} tools=${b.toolMs ?? 0}ms/${b.toolCalls ?? 0}${b.lockWaitMs ? ` lockWait=${b.lockWaitMs}ms` : ''}${b.numTurns ? ` turns=${b.numTurns}` : ''}]`
          : '';
        const costStr = b?.costUsd != null
          ? ` $${b.costUsd.toFixed(4)} (Σ $${totalCostUsd.toFixed(4)})`
          : '';
        console.log(`${status} (${scored.latencyMs}ms)${bd}${costStr}`);

        // Save incrementally every 5 results
        if (allResults.length % 5 === 0) {
          writeFileSync(INCREMENTAL_FILE, JSON.stringify(allResults, null, 2));
        }
      }
    }

    // Final save
    writeFileSync(INCREMENTAL_FILE, JSON.stringify(allResults, null, 2));
    console.log('\n── Generating reports ──────────────────────────────');
    generateReport(questions, allResults);

    // Print summary
    console.log('\n── Summary ─────────────────────────────────────────');
    for (const system of systems) {
      const sysResults = allResults.filter(r => r.system === system);
      const scores = sysResults.filter(r => !r.error).map(r => r.score);
      const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      const sysCost = sysResults.reduce((s, r) => s + (r.breakdown?.costUsd ?? 0), 0);
      const costStr = sysCost > 0 ? ` $${sysCost.toFixed(4)}` : '';
      console.log(`  ${system.padEnd(10)} ${(avg * 100).toFixed(1)}% avg score (${sysResults.length} runs)${costStr}`);
    }
    if (totalCostUsd > 0) {
      console.log(`\n  Total cost: $${totalCostUsd.toFixed(4)}`);
    }

  } finally {
    if (pool) await pool.end();
  }
}

main().catch((err) => {
  console.error('Evaluation failed:', err);
  process.exit(1);
});
