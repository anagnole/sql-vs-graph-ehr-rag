/**
 * Run the `graph-cypher` system on all 105 tier-N questions.
 * Output sits next to the other paradigm-comparison files so the
 * regenerated analysis script can pick it up.
 *
 * Usage:
 *   npx tsx scripts/retest-graph-cypher-tier200.ts
 *   npx tsx scripts/retest-graph-cypher-tier200.ts --tier 2000
 *   npx tsx scripts/retest-graph-cypher-tier200.ts --tier 20000 --model qwen/qwen-2.5-72b-instruct --hosted
 *   npx tsx scripts/retest-graph-cypher-tier200.ts --limit 30   # smoke first
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EvalQuestion } from "../src/eval/types.js";
import { runGraphCypher } from "../src/eval/runner.js";
import { score } from "../src/eval/scorer.js";

const ROOT = join(import.meta.dirname, "..");
const RESULTS = join(ROOT, "results");

const PER_TYPE_TIMEOUT_MS: Record<string, number> = {
  "simple-lookup":  60_000,
  "cohort":         90_000,
  "unanswerable":   60_000,
  "temporal":      120_000,
  "multi-hop":     180_000,
  "reasoning":     240_000,
};

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function main() {
  if (process.env.BRAINIFAI_METRICS === undefined) process.env.BRAINIFAI_METRICS = "1";

  const args = process.argv.slice(2);
  const tier = getArg(args, "--tier") ?? "200";
  if (!["200", "2000", "20000"].includes(tier)) {
    console.error(`Invalid --tier '${tier}'. Must be 200, 2000, or 20000.`);
    process.exit(1);
  }
  process.env.KUZU_DB_PATH = join(ROOT, ".brainifai/data", `kuzu-${tier}`);
  process.env.PG_DSN = `postgresql://user@localhost:5432/ehrdb-${tier}`;
  process.env.BRAINIFAI_TIER = tier;

  const limit = parseInt(getArg(args, "--limit") ?? "0") || 0;
  const hosted = args.includes("--hosted");
  let model = getArg(args, "--model") ?? "claude-haiku-4-5";
  if (hosted) {
    if (!process.env.OPENROUTER_API_KEY) {
      console.error("--hosted requires OPENROUTER_API_KEY in env.");
      process.exit(1);
    }
    if (!model.startsWith("openrouter/")) model = `openrouter/${model}`;
  }
  // Per-model + per-tier output file so runs don't collide.
  const modelSlug = model.replace(/[:/]/g, "-");
  const defaultOutForModel = model.startsWith("claude-")
    ? `round-robin-claude-haiku-4-5-tier-${tier}-graph-cypher.json`
    : `round-robin-${modelSlug}-tier-${tier}-graph-cypher.json`;
  const OUT_FILE = join(RESULTS, getArg(args, "--out-file") ?? defaultOutForModel);

  // Compare against the same model's prior round-robin sweep at the same tier.
  const compareFile = model.startsWith("claude-")
    ? `round-robin-claude-haiku-4-5-tier-${tier}.json`
    : `round-robin-openrouter-qwen-qwen-2.5-72b-instruct-tier-${tier}.json`;
  const v1 = JSON.parse(readFileSync(join(RESULTS, compareFile), "utf-8"));
  const v1QidsInOrder: string[] = [];
  for (const r of v1) {
    if (r.system === "graph" && !v1QidsInOrder.includes(r.questionId)) v1QidsInOrder.push(r.questionId);
  }
  // Pull paired graph + sql-t2s rows for comparison annotation
  const graphByQid = new Map<string, any>();
  const t2sByQid = new Map<string, any>();
  for (const r of v1) {
    if (r.system === "graph") graphByQid.set(r.questionId, r);
    if (r.system === "sql-t2s") t2sByQid.set(r.questionId, r);
  }
  const targetQids = limit > 0 ? v1QidsInOrder.slice(0, limit) : v1QidsInOrder;

  // Question bank with tier-aware cohort GT
  const qbank: EvalQuestion[] = JSON.parse(readFileSync(join(ROOT, "data/generated/evaluation-questions-tiered.json"), "utf-8"));
  const qmap = new Map(qbank.map((q) => [q.id, q]));

  // Resume
  mkdirSync(RESULTS, { recursive: true });
  let out: any[] = [];
  const completed = new Set<string>();
  if (existsSync(OUT_FILE)) {
    out = JSON.parse(readFileSync(OUT_FILE, "utf-8"));
    for (const r of out) completed.add(r.questionId);
    console.log(`Resume: ${completed.size} prior cells loaded\n`);
  }

  console.log(`graph-cypher sweep — tier-${tier}, model=${model}, ${targetQids.length} questions`);
  console.log(`Output: ${OUT_FILE}\n`);

  let totalCost = 0;
  for (const r of out) totalCost += r.newCost ?? 0;

  for (let i = 0; i < targetQids.length; i++) {
    const qid = targetQids[i];
    if (completed.has(qid)) {
      const cached = out.find((r) => r.questionId === qid);
      console.log(`[${i+1}/${targetQids.length}] ${qid} (${cached?.type}) skip (cached)`);
      continue;
    }
    const q = qmap.get(qid);
    if (!q) { console.log(`[${i+1}/${targetQids.length}] ${qid}: NOT FOUND`); continue; }
    const gtByTier = (q as any).groundTruthByTier;
    const qFinal = q.type === "cohort" && gtByTier?.[tier] ? { ...q, answer: gtByTier[tier] } : q;

    const graphCell = graphByQid.get(qid);
    const t2sCell = t2sByQid.get(qid);
    const timeoutMs = PER_TYPE_TIMEOUT_MS[q.type] ?? 120_000;

    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    process.stdout.write(`[${i+1}/${targetQids.length}] ${qid} (${q.type})... `);
    try {
      const runP = runGraphCypher(qFinal, model, { signal: ac.signal });
      const tP = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { ac.abort(); reject(new Error(`Timeout ${timeoutMs}ms`)); }, timeoutMs);
      });
      const res = await Promise.race([runP, tP]);
      const scored = score(qFinal, res);
      if (timer) clearTimeout(timer);
      const cost = scored.breakdown?.costUsd ?? 0;
      totalCost += cost;
      out.push({
        questionId: qid,
        type: q.type,
        question: q.question,
        gt: qFinal.answer,
        newAnswer: scored.answer,
        newFuzzy: scored.score,
        newLatencyMs: scored.latencyMs,
        newCost: cost,
        newTurns: scored.breakdown?.numTurns,
        graphFuzzy: graphCell?.score,
        graphJudge: graphCell?.judgeScore,
        t2sFuzzy: t2sCell?.score,
        t2sJudge: t2sCell?.judgeScore,
      });
      console.log(`fuzzy=${(scored.score*100).toFixed(0)}% (graph f=${graphCell?.score!=null?(graphCell.score*100).toFixed(0)+"%":"?"} j=${graphCell?.judgeScore!=null?(graphCell.judgeScore*100).toFixed(0)+"%":"?"} | t2s f=${t2sCell?.score!=null?(t2sCell.score*100).toFixed(0)+"%":"?"} j=${t2sCell?.judgeScore!=null?(t2sCell.judgeScore*100).toFixed(0)+"%":"?"}) ${scored.latencyMs}ms turns=${scored.breakdown?.numTurns ?? "?"} $${cost.toFixed(4)} (Σ $${totalCost.toFixed(4)})`);
    } catch (err) {
      if (timer) clearTimeout(timer);
      console.log(`✗ ${(err as Error).message.slice(0, 60)}`);
      out.push({ questionId: qid, type: q.type, error: (err as Error).message });
    }
    writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  }

  console.log(`\nDone. Total cost: $${totalCost.toFixed(4)}`);
  const valid = out.filter((r) => r.newFuzzy != null);
  if (valid.length) {
    const avgNew = valid.reduce((s, r) => s + r.newFuzzy, 0) / valid.length;
    const avgGraph = valid.reduce((s, r) => s + (r.graphFuzzy ?? 0), 0) / valid.length;
    const avgT2s = valid.reduce((s, r) => s + (r.t2sFuzzy ?? 0), 0) / valid.length;
    console.log(`graph-cypher fuzzy: ${(avgNew*100).toFixed(1)}%  vs  graph(curated tools): ${(avgGraph*100).toFixed(1)}%  vs  sql-t2s: ${(avgT2s*100).toFixed(1)}%`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
