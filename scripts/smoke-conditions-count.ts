import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executeTool } from "../src/api/tools.js";

const ROOT = join(import.meta.dirname, "..");
process.env.KUZU_DB_PATH = process.env.KUZU_DB_PATH ?? join(ROOT, ".brainifai/data/kuzu-200");
process.env.BRAINIFAI_TIER = "200";

async function main() {
  const qbank = JSON.parse(readFileSync(join(ROOT, "data/generated/evaluation-questions-tiered.json"), "utf-8"));
  for (const id of ["RSN-110", "RSN-108", "RSN-43"]) {
    const q = qbank.find((x: any) => x.id === id);
    const pid = q.patientIds[0];
    const r = (await executeTool("get_active_conditions_count", { patient_id: pid })) as any;
    console.log(`${id} pid=${pid.slice(0,8)} → total=${r.total} clinical=${r.clinical_count} finding=${r.finding_count}`);
    console.log(`  GT: ${q.answer.slice(0, 130)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
