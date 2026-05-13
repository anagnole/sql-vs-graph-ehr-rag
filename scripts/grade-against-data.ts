/**
 * Grade the 20 retest answers against the underlying database, not against
 * the GT string. For each cell, query the actual data and decide whether
 * the model's stated answer is factually correct.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executeTool } from "../src/api/tools.js";

const ROOT = join(import.meta.dirname, "..");
process.env.KUZU_DB_PATH = process.env.KUZU_DB_PATH ?? join(ROOT, ".brainifai/data/kuzu-200");
process.env.BRAINIFAI_TIER = process.env.BRAINIFAI_TIER ?? "200";

const LAB_CODES: Record<string, string> = {
  "hba1c": "4548-4", "a1c": "4548-4",
  "creatinine": "2160-0",
  "systolic": "8480-6", "sbp": "8480-6",
  "bmi": "39156-5", "body mass index": "39156-5",
};

function pickCode(question: string): string | null {
  const q = question.toLowerCase();
  for (const [name, code] of Object.entries(LAB_CODES)) {
    if (q.includes(name)) return code;
  }
  return null;
}

function modelTrend(answer: string): string | null {
  const a = (answer || "").toLowerCase();
  // Refusal: prioritize over keyword detection
  if (a.includes("insufficient data") || a.includes("no measurement") || a.includes("no bmi measurements") ||
      a.includes("no systolic blood pressure readings") || a.includes("no readings") ||
      a.includes("only one hba1c") || a.includes("only 1 measurement") ||
      (a.match(/\bsingle\b.*reading/i))) return "(refused)";

  // Stable wins if the assertion is "stable/unchanged/steady" or explicit "no trend"
  // Use \bstable\b boundaries; require a positive context (not "not stable")
  if (a.match(/\b(remained stable|is stable|stable\.|stable,|stable\b.*throughout|no sustained.*trend|no significant trend|essentially stable|fluctuat\w+ within)\b/i)
      || (a.match(/\bstable\b/) && !a.match(/not stable|previously stable but now|stable but/))) {
    return "stable";
  }
  // Increasing — only if a positive assertion, not negated
  if (a.match(/\b(is increasing|increasing trend|trending up|rising|trending upward|on the rise)\b/i) &&
      !a.match(/no .{0,20}(rising|increasing|upward)/)) return "increasing";
  if (a.match(/\b(is decreasing|decreasing trend|trending down|trending downward|declining)\b/i) &&
      !a.match(/no .{0,20}(decreasing|declining|downward)/)) return "decreasing";

  // Fallback verbs (weaker signal)
  if (a.match(/\b(increased|rose|elevated)\b/) && !a.match(/then (declined|stabilized)/)) return "increasing";
  if (a.match(/\b(decreased|fell|dropped)\b/)) return "decreasing";
  return null;
}

async function main() {
  const cells = JSON.parse(readFileSync(join(ROOT, "results/retest-graph-tier-200-v2.json"), "utf-8"));
  const qbank = JSON.parse(readFileSync(join(ROOT, "data/generated/evaluation-questions-tiered.json"), "utf-8"));
  const qmap = Object.fromEntries(qbank.map((q: any) => [q.id, q]));

  const verdicts = { correct: 0, partial: 0, wrong: 0, refused_correctly: 0, n: 0 };

  for (const cell of cells) {
    const q = qmap[cell.questionId];
    if (!q || !cell.newAnswer) continue;
    const pid = q.patientIds?.[0];
    const ans = cell.newAnswer;
    const ansT = modelTrend(ans);

    let verdict = "?";
    let truth = "";
    let reason = "";

    if (cell.type === "temporal") {
      const code = pickCode(q.question);
      if (code && pid) {
        const t = (await executeTool("get_observation_trend", { patient_id: pid, code })) as any;
        const dataTrend = t?.trend ?? "(no data)";
        truth = `tool says trend=${dataTrend} (n_used=${t?.n_used ?? 0}, n_avail=${t?.n_available ?? 0})`;
        if (ansT === "(refused)") {
          if (t?.n_used <= 1) { verdict = "REFUSED-OK"; verdicts.refused_correctly++; reason = "data thin, refusal honest"; }
          else { verdict = "WRONG-refused"; verdicts.wrong++; reason = `${t.n_used} values exist, refusal unjustified`; }
        } else if (ansT === dataTrend) {
          verdict = "CORRECT"; verdicts.correct++; reason = `model matches data trend`;
        } else if (ansT && dataTrend) {
          // Both side called something; partial credit if model paraphrased correctly
          if ((dataTrend === "increasing" && (ansT === "increasing")) ||
              (dataTrend === "decreasing" && (ansT === "decreasing")) ||
              (dataTrend === "stable" && (ansT === "stable"))) {
            verdict = "CORRECT"; verdicts.correct++;
          } else {
            verdict = "WRONG"; verdicts.wrong++; reason = `model said ${ansT}, data is ${dataTrend}`;
          }
        } else {
          verdict = "PARTIAL"; verdicts.partial++; reason = "model didn't state a clear trend";
        }
      } else {
        // TMP-132 medication duration — judge separately
        if (q.id === "TMP-132") {
          // Check meds for the patient
          const meds = (await executeTool("get_medications", { patient_id: pid })) as any[];
          const metf = meds.filter((m: any) => /metformin/i.test(m.description) && /500.*ER/i.test(m.description));
          truth = `meds rows for Metformin 500 ER: ${metf.length}; first start ${metf[0]?.start_date}, last stop ${metf[metf.length-1]?.stop_date}`;
          // Model said "in three periods, ongoing 9 months" — check if that's reflective of data
          if (/three|3.*period/i.test(ans) && metf.length >= 3) { verdict = "CORRECT-data-shape"; verdicts.correct++; }
          else if (metf.length === 0) { verdict = "WRONG"; verdicts.wrong++; }
          else { verdict = "PARTIAL"; verdicts.partial++; reason = "answer shape differs from data shape"; }
        }
      }
    } else if (cell.type === "multi-hop" && /emergency|ED visit/i.test(q.question)) {
      // Check encounter classes for this patient
      const summary = (await executeTool("get_patient_summary", { patient_id: pid, scope: "encounters" })) as any;
      const encs = summary?.encounters ?? [];
      const classes = [...new Set(encs.map((e: any) => e.encounterClass))];
      const hasED = classes.some((c: any) => /emergency|ed/i.test(String(c)));
      truth = `encounter classes: ${classes.join(",")}; has-ED=${hasED}`;
      if (!hasED && /no.*emergency.*visits|no.*ED.*visits/i.test(ans)) {
        verdict = "CORRECT-refusal"; verdicts.correct++; reason = "no ED encounters in data; correct refusal";
      } else if (hasED) {
        verdict = "?"; verdicts.partial++;
      } else {
        verdict = "PARTIAL"; verdicts.partial++;
      }
    } else if (cell.type === "reasoning") {
      // Get all active conditions including findings to compare counts
      const all = (await executeTool("get_diagnoses", { patient_id: pid, status: "active", include_findings: true })) as any[];
      const allCount = all.length;
      const noFind = all.filter((c: any) => !/\(finding\)/.test(c.description)).length;
      truth = `active conditions: ${allCount} total (${noFind} without findings)`;
      // For RSN-110 specifically: model said a number; check if it matches
      if (q.id === "RSN-110") {
        const m = ans.match(/^\s*(\d+)\b/);
        const claimed = m ? parseInt(m[1]) : null;
        if (claimed !== null && (claimed === allCount || claimed === noFind)) {
          verdict = "CORRECT"; verdicts.correct++;
          reason = `claimed ${claimed} matches data (${allCount} or ${noFind})`;
        } else {
          verdict = "WRONG"; verdicts.wrong++;
          reason = `claimed ${claimed}; data has ${allCount} (${noFind} non-finding)`;
        }
      } else if (q.id === "RSN-108") {
        const ansLow = ans.toLowerCase();
        const burden = /minimal|low|small/i.test(ans) ? "low" : (/high|moderate.*high|severe/i.test(ans) ? "high" : "?");
        const dataBurden = allCount >= 7 ? "high" : (allCount >= 4 ? "moderate" : "low");
        truth += `; data-burden=${dataBurden}`;
        if (burden === dataBurden) { verdict = "CORRECT"; verdicts.correct++; }
        else { verdict = "WRONG"; verdicts.wrong++; reason = `model says ${burden}, data shape is ${dataBurden}`; }
      } else {
        verdict = "(reasoning — not auto-graded)"; verdicts.partial++;
      }
    }

    verdicts.n++;
    console.log(`${cell.questionId.padEnd(8)} ${cell.type.padEnd(11)} ${verdict.padEnd(22)} | ${truth}`);
    if (reason) console.log(`         ${reason}`);
  }

  console.log("\n=== Summary (vs database, not vs GT) ===");
  console.log(`Correct:           ${verdicts.correct} / ${verdicts.n}`);
  console.log(`Correct refusals:  ${verdicts.refused_correctly}`);
  console.log(`Partial/uncertain: ${verdicts.partial}`);
  console.log(`Wrong:             ${verdicts.wrong}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
