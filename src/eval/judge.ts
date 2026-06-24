/**
 * LLM-as-judge scoring — uses a secondary LLM to evaluate answer correctness.
 *
 * Modeled after EHRNoteQA (NeurIPS 2024) which validated GPT-4 as judge
 * with Spearman r=0.78 against clinician ratings.
 *
 * Design:
 * - Runs as a post-scoring pass on existing results (no re-running the eval)
 * - Rubric returns a graded score of 0, 0.5, or 1 (stored directly)
 * - Stores judgeScore + judgeRationale on each ScoredResult
 * - Can use any model (Claude Haiku for cost, Sonnet for accuracy)
 *
 * Usage:
 *   npx tsx src/eval/judge.ts results/incremental-claude-haiku-4-5-20251001-tier-200.json
 *   npx tsx src/eval/judge.ts results/incremental-*.json --judge-model claude-haiku-4-5-20251001
 *   npx tsx src/eval/judge.ts results/incremental-*.json --types reasoning,temporal
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnClaude, buildResponse, OpenRouterProvider } from '@anagnole/claude-cli-wrapper';
import type { EvalQuestion, ScoredResult } from './types.js';

const PROJECT_ROOT = join(import.meta.dirname, '../..');

/**
 * Load the authoritative judge rubric from `docs/judge-calibration.md` §2.
 *
 * The doc is the single source of truth — rubric refinements happen there,
 * case-by-case, during human calibration. Reading at import time means the
 * compiled judge never drifts from what the calibration log captured. §2 is
 * a single contiguous markdown blockquote between the `## 2.` and `## 3.`
 * headings; every line starts with `> `. We strip the blockquote prefix and
 * concatenate.
 *
 * If the file is missing or §2 can't be located, we throw — a silent
 * fall-back to an outdated prompt would make every judge score invalid.
 */
function loadJudgePromptFromCalibrationDoc(): string {
  const docPath = join(PROJECT_ROOT, 'docs/judge-calibration.md');
  const content = readFileSync(docPath, 'utf-8');
  const startMarker = '## 2. Judge system prompt';
  const endMarker = '## 3.';
  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`docs/judge-calibration.md missing '${startMarker}' — rubric cannot load`);
  }
  const endIdx = content.indexOf(endMarker, startIdx);
  if (endIdx === -1) {
    throw new Error(`docs/judge-calibration.md missing '${endMarker}' after §2 — rubric cannot load`);
  }
  const section = content.slice(startIdx, endIdx);
  const blockquoteLines = section
    .split('\n')
    .filter((line) => line.startsWith('>'))
    .map((line) => line.replace(/^>\s?/, ''));
  const prompt = blockquoteLines.join('\n').trim();
  if (!prompt) {
    throw new Error(`docs/judge-calibration.md §2 blockquote is empty — rubric cannot load`);
  }
  return prompt;
}

const JUDGE_PROMPT = loadJudgePromptFromCalibrationDoc();

interface JudgeResponse {
  score: number;
  rationale: string;
  /** Per-call Claude cost in USD, when the judge returns one. 0 for other routes. */
  costUsd?: number;
  /** Prompt + completion tokens, when reported by the route. */
  promptTokens?: number;
  completionTokens?: number;
}

// Lazy-initialized OpenRouter provider — instantiated only when a judge model
// uses the `openrouter/` prefix. Shared across calls.
let openRouterProvider: OpenRouterProvider | null = null;
function getOpenRouter(): OpenRouterProvider {
  if (!openRouterProvider) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY not set — cannot use an openrouter/* judge model.');
    }
    openRouterProvider = new OpenRouterProvider({ apiKey, freeOnly: false });
  }
  return openRouterProvider;
}

/**
 * Parse the judge's JSON response. Shared by Claude-CLI and OpenRouter paths.
 */
function parseJudgeText(text: string): { score: number; rationale: string } {
  // Try to find JSON in the response (model sometimes wraps in markdown)
  const jsonMatch = text.match(/\{[\s\S]*"score"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { score: number; rationale: string };
      return {
        score: Math.max(0, Math.min(1, parsed.score)),
        rationale: parsed.rationale ?? '',
      };
    } catch {
      /* fall through to line-level extraction */
    }
  }
  // Fallback: extract score/rationale fields individually. Match decimals so
  // a 0.5 isn't truncated to 0 by a single-digit capture.
  const scoreMatch = text.match(/"score"\s*:\s*(\d+(?:\.\d+)?)/);
  const rationaleMatch = text.match(/"rationale"\s*:\s*"([^"]+)"/);
  if (scoreMatch) {
    return {
      score: Math.max(0, Math.min(1, parseFloat(scoreMatch[1]))),
      rationale: rationaleMatch?.[1] ?? 'parse fallback',
    };
  }
  return { score: -1, rationale: `Could not parse: ${text.slice(0, 100)}` };
}

/**
 * Call the judge model via Claude CLI. Preserves the existing code path —
 * used when the judge model starts with "claude-" (the default).
 */
async function callJudgeClaude(
  userMessage: string,
  judgeModel: string,
): Promise<JudgeResponse> {
  return new Promise((resolve) => {
    const child = spawnClaude({
      prompt: userMessage,
      model: judgeModel,
      systemPrompt: JUDGE_PROMPT,
      streaming: false,
      maxTurns: 1,
      mcpConfig: '{"mcpServers":{}}',
      dangerouslySkipPermissions: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        resolve({ score: -1, rationale: `CLI exit ${code}: ${stderr.slice(0, 200)}` });
        return;
      }
      try {
        const cli = JSON.parse(stdout.trim());
        if (cli.is_error) {
          resolve({ score: -1, rationale: `CLI error: ${cli.errors?.[0] ?? 'unknown'}` });
          return;
        }
        const response = buildResponse(cli, judgeModel);
        const text = response.content
          .filter((b) => b.type === 'text')
          .map((b) => 'text' in b ? b.text : '')
          .join('');
        const { score, rationale } = parseJudgeText(text);
        resolve({
          score,
          rationale,
          // Claude CLI reports total_cost_usd per invocation; accumulate in caller.
          costUsd: typeof cli.total_cost_usd === 'number' ? cli.total_cost_usd : 0,
        });
      } catch (err) {
        resolve({ score: -1, rationale: `Parse error: ${err}` });
      }
    });
  });
}

/**
 * Call the judge model via OpenRouter. Used when the judge model starts with
 * "openrouter/" (e.g. "openrouter/openai/gpt-4o-mini" for vendor-neutral
 * cross-checking to avoid Claude-judges-Claude self-preference bias).
 */
async function callJudgeOpenRouter(
  userMessage: string,
  judgeModel: string,
): Promise<JudgeResponse> {
  try {
    const resp = await getOpenRouter().complete({
      model: judgeModel,
      system: JUDGE_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 300,
    });
    const text = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => 'text' in b ? b.text ?? '' : '')
      .join('');
    const { score, rationale } = parseJudgeText(text);
    return {
      score,
      rationale,
      // OpenRouter responses don't surface dollar cost inline — return token
      // counts so the caller can post-hoc price by model; set costUsd=0.
      costUsd: 0,
      promptTokens: resp.usage?.input_tokens ?? 0,
      completionTokens: resp.usage?.output_tokens ?? 0,
    };
  } catch (err) {
    return { score: -1, rationale: `OpenRouter error: ${(err as Error).message.slice(0, 200)}` };
  }
}

/**
 * Call the judge model to score a single answer. Routes to the Claude CLI
 * or OpenRouter based on the model-id prefix. Default is claude-haiku.
 */
async function callJudge(
  question: string,
  questionType: string,
  referenceAnswer: string,
  systemAnswer: string,
  judgeModel: string,
): Promise<JudgeResponse> {
  // Truncate long answers and sanitize for CLI transport. Even though
  // OpenRouter doesn't go through a CLI, we keep the same sanitization so
  // both judge routes see identical text (judge-agreement analysis assumes
  // symmetric inputs).
  const cleanAnswer = systemAnswer
    .replace(/\*\*/g, '')         // strip bold markdown
    .replace(/\|[^\n]*\|/g, '')  // strip table rows
    .replace(/---+/g, '')        // strip horizontal rules
    .replace(/[^\x20-\x7E\n]/g, ' ') // replace non-ASCII with space
    .replace(/\n{3,}/g, '\n\n')  // collapse excess newlines
    .slice(0, 1500);             // cap length

  const userMessage = `Question type: ${questionType}

Question: ${question}

Reference answer: ${referenceAnswer}

System answer to evaluate: ${cleanAnswer}`;

  if (judgeModel.startsWith('openrouter/')) return callJudgeOpenRouter(userMessage, judgeModel);
  // Default: Claude CLI (claude-haiku-4-5, claude-sonnet-4-6, etc.)
  return callJudgeClaude(userMessage, judgeModel);
}

/**
 * Run the LLM-as-judge pass on scored results.
 * Modifies results in-place, adding judgeScore and judgeRationale.
 */
export async function runJudge(
  questions: EvalQuestion[],
  results: ScoredResult[],
  options: {
    judgeModel?: string;
    types?: string[];       // only judge these question types
    skipJudged?: boolean;   // skip results that already have a judgeScore
    concurrency?: number;
  } = {},
): Promise<{ totalCost: number; judged: number }> {
  const judgeModel = options.judgeModel ?? 'claude-haiku-4-5-20251001';
  const types = options.types ?? null;
  const skipJudged = options.skipJudged ?? true;
  const concurrency = options.concurrency ?? 2; // CLI processes, not HTTP — keep low

  const questionMap = new Map(questions.map((q) => [q.id, q]));
  let totalCost = 0;
  let judged = 0;

  // Filter results to judge
  const toJudge = results.filter((r) => {
    if (r.error && !r.answer) return false; // nothing to judge
    // Skip successfully judged results; retry failures (judgeScore < 0)
    if (skipJudged && r.judgeScore != null && r.judgeScore >= 0) return false;
    const q = questionMap.get(r.questionId);
    if (!q) return false;
    if (types && !types.includes(q.type)) return false;
    return true;
  });

  console.log(`\nLLM-as-judge: ${toJudge.length} results to evaluate (model: ${judgeModel})`);

  // Process in batches for concurrency
  for (let i = 0; i < toJudge.length; i += concurrency) {
    const batch = toJudge.slice(i, i + concurrency);
    const promises = batch.map(async (r) => {
      const q = questionMap.get(r.questionId)!;
      try {
        const result = await callJudge(
          q.question,
          q.type,
          q.answer,
          r.answer,
          judgeModel,
        );
        r.judgeScore = result.score; // rubric returns 0 / 0.5 / 1 directly
        r.judgeRationale = result.rationale;
        // Accumulate per-call cost when the route reports one (Claude CLI
        // returns total_cost_usd; OpenRouter returns 0 and token counts).
        if (result.costUsd && result.costUsd > 0) totalCost += result.costUsd;
      } catch (err) {
        console.error(`  Judge error on ${r.questionId}: ${err}`);
        r.judgeScore = -1;
        r.judgeRationale = `Judge error: ${err}`;
      }
    });

    await Promise.all(promises);
    judged += batch.length;

    if (judged % 20 === 0 || judged === toJudge.length) {
      console.log(`  judged ${judged}/${toJudge.length} (~$${totalCost.toFixed(4)})`);
    }
  }

  return { totalCost, judged };
}

// ─── CLI entrypoint ─────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help') {
    console.log('Usage: npx tsx src/eval/judge.ts <incremental-file.json> [options]');
    console.log('  --judge-model <model>   Judge model. Accepts claude-* (via CLI) or');
    console.log('                          openrouter/<vendor>/<model> (needs OPENROUTER_API_KEY).');
    console.log('                          Default: claude-haiku-4-5-20251001');
    console.log('  --types <t1,t2,...>      Only judge these question types');
    console.log('  --rejudge               Re-judge even if already scored');
    console.log('  --concurrency <n>       Parallel judge calls (default: 2 for Claude CLI,');
    console.log('                          safe to raise to 5–10 for OpenRouter)');
    process.exit(0);
  }

  const file = args[0];
  const judgeModel = args.includes('--judge-model') ? args[args.indexOf('--judge-model') + 1] : undefined;
  const typesArg = args.includes('--types') ? args[args.indexOf('--types') + 1] : undefined;
  const rejudge = args.includes('--rejudge');
  const concurrencyArg = args.includes('--concurrency') ? parseInt(args[args.indexOf('--concurrency') + 1]) : undefined;

  // Load questions
  const questionsFile = join(PROJECT_ROOT, 'data/generated/evaluation-questions-tiered.json');
  const questions: EvalQuestion[] = JSON.parse(readFileSync(questionsFile, 'utf-8'));

  // Load results
  const data = JSON.parse(readFileSync(file, 'utf-8'));
  const results: ScoredResult[] = Array.isArray(data) ? data : data.results ?? [];

  console.log(`Loaded ${results.length} results from ${file}`);
  console.log(`Questions bank: ${questions.length} questions`);

  const { totalCost, judged } = await runJudge(questions, results, {
    judgeModel,
    types: typesArg?.split(','),
    skipJudged: !rejudge,
    concurrency: concurrencyArg,
  });

  // Write back
  if (Array.isArray(data)) {
    writeFileSync(file, JSON.stringify(results, null, 2));
  } else {
    data.results = results;
    writeFileSync(file, JSON.stringify(data, null, 2));
  }

  console.log(`\nDone. Judged ${judged} results, estimated cost: $${totalCost.toFixed(4)}`);

  // Print summary comparing automated vs judge scores
  // Only include successfully judged results (score >= 0; -1 means judge error)
  const judgedResults = results.filter((r) => r.judgeScore != null && r.judgeScore >= 0);
  const failedCount = results.filter((r) => r.judgeScore != null && r.judgeScore < 0).length;
  if (failedCount > 0) {
    console.log(`  (${failedCount} judge calls failed — excluded from comparison)`);
  }
  if (judgedResults.length > 0) {
    const autoAvg = judgedResults.reduce((s, r) => s + r.score, 0) / judgedResults.length;
    const judgeAvg = judgedResults.reduce((s, r) => s + r.judgeScore!, 0) / judgedResults.length;
    console.log(`\n─── Automated vs Judge comparison ───`);
    console.log(`  Automated score avg: ${(autoAvg * 100).toFixed(1)}%`);
    console.log(`  Judge score avg:     ${(judgeAvg * 100).toFixed(1)}%`);

    // Per-type comparison
    const typeSet = new Set(questions.map((q) => q.type));
    for (const type of [...typeSet].sort()) {
      const typeQIds = new Set(questions.filter((q) => q.type === type).map((q) => q.id));
      const typeResults = judgedResults.filter((r) => typeQIds.has(r.questionId));
      if (typeResults.length === 0) continue;
      const typeAuto = typeResults.reduce((s, r) => s + r.score, 0) / typeResults.length;
      const typeJudge = typeResults.reduce((s, r) => s + r.judgeScore!, 0) / typeResults.length;
      const delta = ((typeJudge - typeAuto) * 100).toFixed(1);
      console.log(`  ${type.padEnd(16)}: auto=${(typeAuto * 100).toFixed(1)}% judge=${(typeJudge * 100).toFixed(1)}% (${delta.startsWith('-') ? delta : '+' + delta})`);
    }

    // Agreement rate (both agree on pass/fail at 0.5 threshold)
    let agree = 0;
    for (const r of judgedResults) {
      const autoPass = r.score >= 0.5;
      const judgePass = r.judgeScore! >= 0.5;
      if (autoPass === judgePass) agree++;
    }
    console.log(`\n  Agreement rate (pass/fail at 50%): ${(agree / judgedResults.length * 100).toFixed(1)}%`);
  }
}

main().catch(console.error);
