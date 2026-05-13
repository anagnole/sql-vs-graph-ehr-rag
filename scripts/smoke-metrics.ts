/**
 * Smoke test: exercise the metrics instrumentation against the real Kuzu DB.
 * Verifies that withLock + executeTool record per-query timings.
 *
 * Run: BRAINIFAI_METRICS=1 npx tsx scripts/smoke-metrics.ts
 */
import { resetMetrics, getMetrics } from "../src/api/metrics.js";
import { executeTool } from "../src/api/tools.js";

async function main() {
  resetMetrics();
  console.log("Initial:", getMetrics());

  console.log("\n→ search_patients(query='smith')");
  const r1 = (await executeTool("search_patients", { query: "smith", limit: 5 })) as Array<{ patient_id: string }>;
  console.log("  results:", r1.length);
  console.log("  metrics:", getMetrics());

  if (r1.length > 0) {
    const pid = r1[0].patient_id;
    console.log(`\n→ get_patient_summary(patient_id='${pid}') — fires 4 sequential queries`);
    const r2 = await executeTool("get_patient_summary", { patient_id: pid });
    console.log("  keys:", Object.keys(r2 as Record<string, unknown>));
    console.log("  metrics:", getMetrics());
  }

  console.log("\n→ find_cohort({age_min: 65, gender: 'F'}) — single complex query");
  await executeTool("find_cohort", { age_min: 65, gender: "F" });
  console.log("  metrics:", getMetrics());
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
