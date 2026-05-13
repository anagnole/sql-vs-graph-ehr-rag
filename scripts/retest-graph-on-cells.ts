/**
 * Re-run the `graph` system on a fixed list of question IDs against tier-200,
 * using the updated tool catalog. Saves to a separate file so the original
 * round-robin results are preserved.
 *
 * Usage:
 *   npx tsx scripts/retest-graph-on-cells.ts
 *
 * Output: results/retest-graph-tier-200-v2.json — only the cells we re-ran,
 * each with `score` (fuzzy), `originalFuzzy` and `originalJudge` for comparison.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EvalQuestion } from "../src/eval/types.js";
import { runGraph } from "../src/eval/runner.js";
import { score } from "../src/eval/scorer.js";

const ROOT = join(import.meta.dirname, "..");
const RESULTS = join(ROOT, "results");

// The 20 candidates we picked
const TARGET_QIDS = [
  "TMP-1", "TMP-2", "TMP-3", "TMP-4", "TMP-9", "TMP-11",
  "TMP-17", "TMP-18", "TMP-19", "TMP-57", "TMP-59", "TMP-132",
  "MH-49", "MH-52",
  "RSN-5", "RSN-24", "RSN-25", "RSN-43", "RSN-108", "RSN-110",
];

async function main() {
  if (process.env.BRAINIFAI_METRICS === undefined) process.env.BRAINIFAI_METRICS = "1";
  process.env.KUZU_DB_PATH = join(ROOT, ".brainifai/data/kuzu-200");
  process.env.PG_DSN = "postgresql://user@localhost:5432/ehrdb-200";
  process.env.BRAINIFAI_TIER = "200";

  const model = process.argv.includes("--model")
    ? process.argv[process.argv.indexOf("--model") + 1]
    : "claude-haiku-4-5";

  const qbank: EvalQuestion[] = JSON.parse(readFileSync(join(ROOT, "data/generated/evaluation-questions-tiered.json"), "utf-8"));
  const qmap = new Map(qbank.map((q) => [q.id, q]));

  const orig = JSON.parse(readFileSync(join(RESULTS, "round-robin-claude-haiku-4-5-tier-200.json"), "utf-8"));
  const origByKey = new Map<string, any>();
  for (const r of orig) origByKey.set(`${r.system}:${r.questionId}`, r);

  const PER_TYPE_TIMEOUT_MS: Record<string, number> = {
    "simple-lookup": 60_000, "cohort": 90_000, "unanswerable": 60_000,
    "temporal": 120_000, "multi-hop": 180_000, "reasoning": 240_000,
  };

  const out: any[] = [];
  let totalCost = 0;
  console.log(`Re-testing ${TARGET_QIDS.length} cells on graph (tier-200, ${model})\n`);

  for (let i = 0; i < TARGET_QIDS.length; i++) {
    const qid = TARGET_QIDS[i];
    const q = qmap.get(qid);
    if (!q) { console.log(`[${i+1}/${TARGET_QIDS.length}] ${qid}: NOT FOUND`); continue; }
    // Apply tier-200 cohort GT swap (defensive — TARGET_QIDS doesn't include cohort, but mirroring run.ts)
    const gtByTier = (q as any).groundTruthByTier;
    const qFinal = q.type === "cohort" && gtByTier?.["200"] ? { ...q, answer: gtByTier["200"] } : q;

    const origCell = origByKey.get(`graph:${qid}`);
    const timeoutMs = PER_TYPE_TIMEOUT_MS[q.type] ?? 120_000;

    const abortController = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const tStart = Date.now();
    process.stdout.write(`[${i+1}/${TARGET_QIDS.length}] ${qid} (${q.type})... `);
    try {
      const runP = runGraph(qFinal, model, { signal: abortController.signal });
      const tP = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abortController.abort(); reject(new Error(`Timeout ${timeoutMs}ms`)); }, timeoutMs);
      });
      const res = await Promise.race([runP, tP]);
      const scored = score(qFinal, res);
      if (timer) clearTimeout(timer);
      const cost = scored.breakdown?.costUsd ?? 0;
      totalCost += cost;
      const oFuzzy = origCell?.score;
      const oJudge = origCell?.judgeScore;
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
        originalFuzzy: oFuzzy,
        originalJudge: oJudge,
        delta_fuzzy: typeof oFuzzy === "number" ? scored.score - oFuzzy : null,
      });
      console.log(`fuzzy=${(scored.score*100).toFixed(0)}% (was f=${typeof oFuzzy==="number"?(oFuzzy*100).toFixed(0)+"%":"?"} j=${typeof oJudge==="number"?(oJudge*100).toFixed(0)+"%":"?"}) ${scored.latencyMs}ms turns=${scored.breakdown?.numTurns ?? "?"} $${cost.toFixed(4)}`);
    } catch (err) {
      console.log(`✗ ${(err as Error).message.slice(0, 60)}`);
      out.push({ questionId: qid, type: q.type, error: (err as Error).message });
    } finally {
      if (timer) clearTimeout(timer);
    }
    // Save incrementally
    mkdirSync(RESULTS, { recursive: true });
    writeFileSync(join(RESULTS, "retest-graph-tier-200-v2.json"), JSON.stringify(out, null, 2));
  }

  console.log(`\nDone. Total cost: $${totalCost.toFixed(4)}`);
  // Summary
  const valid = out.filter((r) => r.newFuzzy != null);
  const avgNew = valid.reduce((s, r) => s + r.newFuzzy, 0) / valid.length;
  const avgOld = valid.reduce((s, r) => s + (r.originalFuzzy ?? 0), 0) / valid.length;
  console.log(`Avg new fuzzy: ${(avgNew*100).toFixed(1)}%, avg original fuzzy: ${(avgOld*100).toFixed(1)}%, delta: ${((avgNew-avgOld)*100).toFixed(1)}pp`);
}

main().catch((e) => { console.error(e); process.exit(1); });
