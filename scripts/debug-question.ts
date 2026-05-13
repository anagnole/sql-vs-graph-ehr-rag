/**
 * Debug a single eval question end-to-end with verbose Claude CLI logging.
 *
 * Usage: BRAINIFAI_METRICS=1 npx tsx scripts/debug-question.ts COH-12
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnClaude, buildResponse } from "@anagnole/claude-cli-wrapper";
import type { EvalQuestion } from "../src/eval/types.js";

const PROJECT_DIR = join(import.meta.dirname, "..");
const SYSTEM_INSTRUCTION = `You are a clinical EHR assistant. Answer the question precisely and concisely based on the available patient data. Give only the answer, no explanations or caveats.`;

async function main() {
  const id = process.argv[2];
  const maxTurns = parseInt(process.argv[3] ?? "5");
  const model = process.argv[4] ?? "claude-haiku-4-5-20251001";

  if (!id) {
    console.error("Usage: tsx scripts/debug-question.ts <question-id> [maxTurns] [model]");
    process.exit(1);
  }

  // Try the tiered file first (current bank), fall back to the legacy file
  const tieredFile = join(PROJECT_DIR, "data", "generated", "evaluation-questions-tiered.json");
  const legacyFile = join(PROJECT_DIR, "data", "generated", "evaluation-questions.json");
  const questions: EvalQuestion[] = JSON.parse(
    readFileSync(existsSync(tieredFile) ? tieredFile : legacyFile, "utf-8"),
  );
  const q = questions.find(x => x.id === id);
  if (!q) {
    console.error(`Question ${id} not found`);
    process.exit(1);
  }

  console.log(`── Question ${q.id} (${q.type}) ──`);
  console.log(`  Q: ${q.question}`);
  console.log(`  Expected: ${q.answer}`);
  console.log(`  maxTurns: ${maxTurns}`);
  console.log(`  model: ${model}`);
  console.log();

  const start = Date.now();
  const child = spawnClaude({
    prompt: q.question,
    model,
    systemPrompt: SYSTEM_INSTRUCTION,
    streaming: false,
    maxTurns,
    workingDirectory: PROJECT_DIR,
    strictMcpConfig: false,
    dangerouslySkipPermissions: true,
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (b: Buffer) => { stdout += b.toString(); });
  child.stderr?.on("data", (b: Buffer) => {
    const s = b.toString();
    stderr += s;
    process.stderr.write(`[stderr] ${s}`);
  });

  const code: number | null = await new Promise((resolve) => {
    child.on("close", (c) => resolve(c));
    child.on("error", (e) => { console.error("spawn error:", e); resolve(-1); });
  });

  const wallMs = Date.now() - start;
  console.log(`\n── Result ──`);
  console.log(`  exit code: ${code}`);
  console.log(`  wall time: ${wallMs}ms`);
  console.log(`  stdout bytes: ${stdout.length}`);
  console.log(`  stderr bytes: ${stderr.length}`);

  if (stdout.trim()) {
    try {
      const cli = JSON.parse(stdout.trim());
      console.log(`  cli.duration_ms: ${cli.duration_ms}`);
      console.log(`  cli.num_turns: ${cli.num_turns}`);
      console.log(`  cli.subtype: ${cli.subtype}`);
      console.log(`  cli.is_error: ${cli.is_error}`);
      if (cli.is_error) {
        console.log(`  cli.error: ${JSON.stringify(cli.result ?? cli, null, 2).slice(0, 2000)}`);
      } else {
        const resp = buildResponse(cli, model);
        const text = resp.content.filter(b => b.type === "text").map(b => b.text).join("");
        console.log(`\n  ANSWER: ${text.trim()}`);
      }
    } catch (e) {
      console.log(`  (stdout is not JSON)`);
      console.log(stdout.slice(0, 2000));
    }
  } else {
    console.log("  (no stdout)");
  }

  if (stderr.trim()) {
    console.log(`\n── stderr (full) ──\n${stderr}`);
  }
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
