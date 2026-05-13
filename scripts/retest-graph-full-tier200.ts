/**
 * Full tier-200 graph re-sweep with the updated tool catalog
 * (get_observation_trend + auto-widen + reinforced system prompt).
 *
 * Same 105 questions as the original tier-200 round-robin; only the `graph`
 * system runs. Output is independent so we can diff v1 vs v2 cleanly:
 *
 *   results/round-robin-claude-haiku-4-5-tier-200-graph-v2.json
 *
 * Resume-safe — re-running skips already-judged cells. Saves after every
 * question so a Ctrl-C loses at most one cell.
 *
 * Usage:
 *   npx tsx scripts/retest-graph-full-tier200.ts
 *   npx tsx scripts/retest-graph-full-tier200.ts --limit 30   # smoke a subset first
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EvalQuestion } from "../src/eval/types.js";
import { runGraph } from "../src/eval/runner.js";
import { score } from "../src/eval/scorer.js";

const ROOT = join(import.meta.dirname, "..");
const RESULTS = join(ROOT, "results");
// Override via --out-file flag if you want a different version label
const DEFAULT_OUT = "round-robin-claude-haiku-4-5-tier-200-graph-v3.json";

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
  process.env.KUZU_DB_PATH = join(ROOT, ".brainifai/data/kuzu-200");
  process.env.PG_DSN = "postgresql://user@localhost:5432/ehrdb-200";
  process.env.BRAINIFAI_TIER = "200";

  const args = process.argv.slice(2);
  const limit = parseInt(getArg(args, "--limit") ?? "0") || 0;
  const model = getArg(args, "--model") ?? "claude-haiku-4-5";
  const OUT_FILE = join(RESULTS, getArg(args, "--out-file") ?? DEFAULT_OUT);

  // Use the same 105 question IDs the v1 sweep covered, in the same order.
  const v1 = JSON.parse(readFileSync(join(RESULTS, "round-robin-claude-haiku-4-5-tier-200.json"), "utf-8"));
  const v1Map = new Map<string, any>();
  for (const r of v1) v1Map.set(`${r.system}:${r.questionId}`, r);
  const v1QidsInOrder: string[] = [];
  for (const r of v1) {
    if (r.system === "graph" && !v1QidsInOrder.includes(r.questionId)) v1QidsInOrder.push(r.questionId);
  }
  const targetQids = limit > 0 ? v1QidsInOrder.slice(0, limit) : v1QidsInOrder;

  // Load question bank, swap cohort GT for tier-200
  const qbank: EvalQuestion[] = JSON.parse(readFileSync(join(ROOT, "data/generated/evaluation-questions-tiered.json"), "utf-8"));
  const qmap = new Map(qbank.map((q) => [q.id, q]));

  // Resume: load existing v2 file
  mkdirSync(RESULTS, { recursive: true });
  let out: any[] = [];
  const completed = new Set<string>();
  if (existsSync(OUT_FILE)) {
    out = JSON.parse(readFileSync(OUT_FILE, "utf-8"));
    for (const r of out) completed.add(r.questionId);
    console.log(`Resume: ${completed.size} prior cells loaded\n`);
  }

  console.log(`Full graph re-sweep — tier-200, model=${model}, ${targetQids.length} questions`);
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
    const qFinal = q.type === "cohort" && gtByTier?.["200"] ? { ...q, answer: gtByTier["200"] } : q;

    const v1Cell = v1Map.get(`graph:${qid}`);
    const timeoutMs = PER_TYPE_TIMEOUT_MS[q.type] ?? 120_000;

    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    process.stdout.write(`[${i+1}/${targetQids.length}] ${qid} (${q.type})... `);
    try {
      const runP = runGraph(qFinal, model, { signal: ac.signal });
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
        v1Fuzzy: v1Cell?.score,
        v1Judge: v1Cell?.judgeScore,
        v1Answer: v1Cell?.answer?.slice(0, 400),
      });
      const oFuzzy = v1Cell?.score;
      const oJudge = v1Cell?.judgeScore;
      console.log(`fuzzy=${(scored.score*100).toFixed(0)}% (v1 f=${typeof oFuzzy==="number"?(oFuzzy*100).toFixed(0)+"%":"?"} j=${typeof oJudge==="number"?(oJudge*100).toFixed(0)+"%":"?"}) ${scored.latencyMs}ms turns=${scored.breakdown?.numTurns ?? "?"} $${cost.toFixed(4)} (Σ $${totalCost.toFixed(4)})`);
    } catch (err) {
      if (timer) clearTimeout(timer);
      console.log(`✗ ${(err as Error).message.slice(0, 60)}`);
      out.push({ questionId: qid, type: q.type, error: (err as Error).message });
    }
    writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  }

  console.log(`\nDone. Total cost: $${totalCost.toFixed(4)}`);
  // Headline summary
  const valid = out.filter((r) => r.newFuzzy != null);
  const avgNew = valid.reduce((s, r) => s + r.newFuzzy, 0) / valid.length;
  const avgV1 = valid.reduce((s, r) => s + (r.v1Fuzzy ?? 0), 0) / valid.length;
  const avgV1Judge = valid.filter((r) => r.v1Judge != null).reduce((s, r) => s + r.v1Judge, 0) / Math.max(1, valid.filter((r) => r.v1Judge != null).length);
  console.log(`v1 fuzzy avg: ${(avgV1*100).toFixed(1)}%, v2 fuzzy avg: ${(avgNew*100).toFixed(1)}%, delta: ${((avgNew-avgV1)*100).toFixed(1)}pp`);
  console.log(`(v1 judge avg ${(avgV1Judge*100).toFixed(1)}% — judge v2 still pending)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
