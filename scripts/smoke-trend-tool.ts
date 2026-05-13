/**
 * Smoke-test the new get_observation_trend tool against tier-200 cases
 * where graph scored < 1.0 on a temporal question. Confirms the tool's
 * `trend` matches GT before we bother re-running through Claude CLI.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executeTool } from "../src/api/tools.js";

const ROOT = join(import.meta.dirname, "..");
process.env.KUZU_DB_PATH = process.env.KUZU_DB_PATH ?? join(ROOT, ".brainifai/data/kuzu-200");
process.env.BRAINIFAI_TIER = process.env.BRAINIFAI_TIER ?? "200";

// Hardcoded LOINC codes for the labs the temporal questions ask about
const LAB_CODES: Record<string, string> = {
  "hba1c": "4548-4",
  "a1c": "4548-4",
  "creatinine": "2160-0",
  "systolic blood pressure": "8480-6",
  "sbp": "8480-6",
  "diastolic blood pressure": "8462-4",
  "dbp": "8462-4",
  "bmi": "39156-5",
  "body mass index": "39156-5",
  "total cholesterol": "2093-3",
};

function pickCode(question: string): string | null {
  const q = question.toLowerCase();
  for (const [name, code] of Object.entries(LAB_CODES)) {
    if (q.includes(name)) return code;
  }
  return null;
}

async function main() {
  const qbank = JSON.parse(readFileSync(join(ROOT, "data/generated/evaluation-questions-tiered.json"), "utf-8"));
  const qmap = Object.fromEntries(qbank.map((q: any) => [q.id, q]));
  const TARGETS = ["TMP-1","TMP-2","TMP-3","TMP-4","TMP-9","TMP-11","TMP-17","TMP-18","TMP-19","TMP-57","TMP-59"];

  let correct = 0;
  let total = 0;
  for (const id of TARGETS) {
    const q = qmap[id];
    if (!q) { console.log(`${id}: NOT FOUND`); continue; }
    const code = pickCode(q.question);
    if (!code) { console.log(`${id}: no code map for "${q.question}"`); continue; }
    const pid = q.patientIds?.[0];
    if (!pid) { console.log(`${id}: no patient id`); continue; }

    const r = (await executeTool("get_observation_trend", { patient_id: pid, code })) as any;
    const gt = q.groundTruthByTier?.["200"] ?? q.answer;
    const gtTrend = (gt.match(/^(increasing|decreasing|stable)/i) ?? [])[1]?.toLowerCase();
    const toolTrend = r?.trend ?? "(none)";
    const match = gtTrend && toolTrend === gtTrend ? "✓" : "✗";
    total++;
    if (gtTrend && toolTrend === gtTrend) correct++;
    console.log(`${id} ${match} tool=${toolTrend.padEnd(10)} gt=${(gtTrend||"?").padEnd(10)} n=${r?.n ?? 0}  Q: ${q.question.slice(0,55)}`);
  }
  console.log(`\nTrend match: ${correct}/${total}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
