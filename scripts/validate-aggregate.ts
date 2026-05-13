/**
 * Validate aggregate_observation_for_cohort against COH-12's ground truth.
 * Expected: 184.41 across 226 patients with Hyperlipidemia.
 */
import { executeTool } from "../src/api/tools.js";

async function main() {
  console.log("─── find_observation_concepts('cholesterol') ───");
  const concepts = await executeTool("find_observation_concepts", { query: "cholesterol", limit: 5 });
  console.log(JSON.stringify(concepts, null, 2));

  console.log("\n─── find_observation_concepts('Total Cholesterol') ───");
  const c2 = await executeTool("find_observation_concepts", { query: "Total Cholesterol", limit: 5 });
  console.log(JSON.stringify(c2, null, 2));

  console.log("\n\nTest: average Total Cholesterol for Hyperlipidemia patients");
  console.log("Expected: 184.41 across 226 patients\n");

  const result = await executeTool("aggregate_observation_for_cohort", {
    condition: "Hyperlipidemia",
    observation: "Total Cholesterol",
    aggregation: "avg",
  });
  console.log("Result:", JSON.stringify(result, null, 2));

  console.log("\n— Trying with LOINC code 2093-3 instead —");
  const r2 = await executeTool("aggregate_observation_for_cohort", {
    condition: "Hyperlipidemia",
    observation_code: "2093-3",
    aggregation: "avg",
  });
  console.log("Result:", JSON.stringify(r2, null, 2));

  console.log("\n— Other aggregations on the same cohort —");
  for (const agg of ["min", "max", "median", "count"]) {
    const r = await executeTool("aggregate_observation_for_cohort", {
      condition: "Hyperlipidemia",
      observation: "Total Cholesterol",
      aggregation: agg,
    });
    console.log(`  ${agg}: ${JSON.stringify(r)}`);
  }
}

main().catch(e => { console.error("FAIL:", e); process.exit(1); });
