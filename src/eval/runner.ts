/**
 * Evaluation runners — call LLMs via @anagnole/claude-cli-wrapper providers
 * for each question under 4 retrieval modes.
 *
 * Supports both Claude (via CLI) and Ollama models (via HTTP).
 * Pass model name to each runner to control which model is used.
 *
 * - graph: Claude uses MCP tools, Ollama uses native tool calling against Kuzu
 * - sql / sql-fts: pre-retrieves context via adapter, injects into prompt
 * - llm-only: injects serialized patient record into prompt
 */

import pg from 'pg';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  spawnClaude,
  buildResponse,
  ProviderRegistry,
  ClaudeCliProvider,
  OllamaProvider,
  OpenRouterProvider,
  type Provider,
} from '@anagnole/claude-cli-wrapper';
import type { EvalQuestion, RunResult } from './types.js';
import { SqlAdapter } from '../sql/adapter.js';
import { SqlFtsAdapter } from '../sql/fts-adapter.js';
import { SCHEMA_DESC } from '../sql/schema.js';
import {
  buildPatientPrompt,
  buildCohortPrompt,
  loadPatientEntry,
  loadAllPatientEntries,
} from '../prompt/builder.js';
import { TOOL_DEFS, executeTool } from '../api/tools.js';
import { resetMetrics, getMetrics, metricsEnabled, recordTool } from '../api/metrics.js';
import { denseRetrieve } from './retrieval.js';
import type { RunResult as _RR } from './types.js';

type Breakdown = NonNullable<_RR['breakdown']>;

function buildBreakdown(totalMs: number, extra?: Partial<Breakdown>): Breakdown | undefined {
  if (!metricsEnabled()) return undefined;
  const m = getMetrics();
  return {
    totalMs,
    kuzuMs: m.kuzuMs,
    kuzuCalls: m.kuzuCalls,
    lockWaitMs: m.lockWaitMs,
    toolMs: m.toolMs,
    toolCalls: m.toolCalls,
    perTool: m.perTool,
    ...extra,
  };
}

const SYSTEM_INSTRUCTION = `You are a clinical EHR assistant. Each question refers to a specific patient whose ID is provided in the message. Answer precisely and concisely based on the available patient data. Give only the answer, no explanations or caveats.`;

const PROJECT_DIR = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Attach the patient ID to the user prompt as out-of-band context. Matches
 * FHIR-AgentBench / EHRSQL convention: the patient is established by the
 * session, not named in the question text itself.
 */
function withPatientContext(q: EvalQuestion, body: string): string {
  if (!q.patientIds || q.patientIds.length === 0) return body;
  return `Patient ID: ${q.patientIds[0]}\n\n${body}`;
}

// Build provider registry. OpenRouter is registered first so its
// "openrouter/"-prefixed model IDs get routed to it ahead of Ollama's
// catch-all canHandle. Only registered when OPENROUTER_API_KEY is present
// (the --hosted flag in run.ts enforces this upstream).
const registry = new ProviderRegistry();
registry.register(new ClaudeCliProvider({
  claudePath: process.env.CLAUDE_PATH,
}));
if (process.env.OPENROUTER_API_KEY) {
  registry.register(new OpenRouterProvider({
    apiKey: process.env.OPENROUTER_API_KEY,
    freeOnly: false,
  }));
}
registry.register(new OllamaProvider({
  baseUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
}));

export { registry };

// ─── Unified LLM caller ─────────────────────────────────────────────────────

async function callLlm(
  prompt: string,
  model: string,
  opts?: {
    system?: string;
    useMcp?: boolean;
    maxTurns?: number;
    mcpConfigOverride?: string;
    /** Copilot CLI only: restrict the model to exactly these tool names. */
    availableTools?: string[];
    /** Cancels the underlying subprocess / HTTP call when aborted. */
    signal?: AbortSignal;
  },
): Promise<{ answer: string; latencyMs: number; llmReportedMs?: number; numTurns?: number; costUsd?: number; outputTokens?: number }> {
  // Copilot CLI path — official GitHub Copilot CLI in programmatic mode.
  // Same mediation class as the Claude CLI route: vendor agent harness with
  // our MCP tools attached. Matched by the "copilot/" model prefix before
  // registry resolution (Ollama's catch-all would otherwise claim it).
  if (isCopilotModel(model)) {
    return callCopilot(prompt, model, opts);
  }

  const provider = registry.resolve(model);
  if (!provider) {
    throw new Error(`No provider found for model: ${model}`);
  }

  // Claude CLI path — supports MCP tools and multi-turn
  if (provider.name === 'claude-cli') {
    return callClaude(prompt, model, opts);
  }

  // Ollama/other provider path — text completion only
  return callProvider(prompt, model, provider, opts);
}

async function callClaude(
  prompt: string,
  model: string,
  opts?: {
    system?: string;
    useMcp?: boolean;
    maxTurns?: number;
    /** Override the MCP config JSON (enables custom MCP servers without project config). */
    mcpConfigOverride?: string;
    /** Kills the Claude CLI subprocess when aborted. */
    signal?: AbortSignal;
  },
): Promise<{ answer: string; latencyMs: number; llmReportedMs?: number; numTurns?: number; costUsd?: number; outputTokens?: number }> {
  const start = Date.now();

  const useCustomMcp = !!opts?.mcpConfigOverride;
  const child = spawnClaude({
    prompt,
    model,
    systemPrompt: opts?.system,
    streaming: false,
    maxTurns: opts?.maxTurns ?? 1,
    workingDirectory: (opts?.useMcp || useCustomMcp) ? PROJECT_DIR : undefined,
    strictMcpConfig: !(opts?.useMcp || useCustomMcp),
    mcpConfig: opts?.mcpConfigOverride ?? (opts?.useMcp ? undefined : '{"mcpServers":{}}'),
    dangerouslySkipPermissions: true,
  });

  // Wire the abort signal to the subprocess. SIGTERM first, SIGKILL after
  // 2s if the CLI doesn't exit cleanly — prevents zombie CLI processes
  // from running on after the outer harness has moved on, which otherwise
  // keeps burning API tokens and leaks I/O buffers.
  let killedByAbort = false;
  let killEscalation: NodeJS.Timeout | undefined;
  const onAbort = () => {
    killedByAbort = true;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    killEscalation = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, 2000);
  };
  if (opts?.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      const latencyMs = Date.now() - start;
      // Clear the SIGKILL escalation now that the child has exited, and
      // detach the abort listener so the signal object doesn't retain a
      // reference to our closure.
      if (killEscalation) clearTimeout(killEscalation);
      if (opts?.signal) opts.signal.removeEventListener('abort', onAbort);

      // If we killed the child via abort, surface as a clean timeout
      // instead of a generic "CLI exit 143".
      if (killedByAbort) {
        reject(new Error(`Killed by abort (exit ${code}, ${latencyMs}ms elapsed)`));
        return;
      }

      // Helper: extract the actual Claude error from stdout JSON. Claude CLI
      // v2.1.97 reports errors via `errors` (array), `terminal_reason`, and
      // `subtype` (e.g. "error_max_turns"). Older versions used `error` or
      // `result` — we read all known field names for forward/backward compat.
      const parseCliError = (): string => {
        const s = stdout.trim();
        if (!s) return '';
        try {
          const cli = JSON.parse(s);
          if (cli.is_error) {
            const msg =
              (Array.isArray(cli.errors) && cli.errors.length > 0 && String(cli.errors[0])) ||
              (typeof cli.terminal_reason === 'string' && cli.terminal_reason) ||
              (typeof cli.subtype === 'string' && cli.subtype) ||
              (typeof cli.error === 'string' && cli.error) ||
              (typeof cli.error_message === 'string' && cli.error_message) ||
              (typeof cli.result === 'string' && cli.result) ||
              'unknown';
            const turns = cli.num_turns != null ? ` · ${cli.num_turns} turns` : '';
            const cost = cli.total_cost_usd != null ? ` · $${cli.total_cost_usd.toFixed(4)}` : '';
            return `${msg}${turns}${cost}`;
          }
        } catch { /* not JSON */ }
        return s.slice(0, 300);
      };

      if (code !== 0) {
        const cliErr = parseCliError();
        const detail = cliErr || stderr.slice(0, 500) || '(no output)';
        reject(new Error(`Claude CLI exit ${code}: ${detail}`));
        return;
      }
      if (!stdout.trim()) {
        reject(new Error(`Claude CLI returned empty output (stderr: ${stderr.slice(0, 500)})`));
        return;
      }

      try {
        const cli = JSON.parse(stdout.trim());
        // Claude can exit 0 but still report is_error (e.g., agent stopped early)
        if (cli.is_error) {
          const cliErr = parseCliError();
          reject(new Error(`Claude CLI is_error: ${cliErr}`));
          return;
        }
        const response = buildResponse(cli, model);
        const text = response.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('');
        resolve({
          answer: text.trim(),
          latencyMs: cli.duration_ms ?? latencyMs,
          llmReportedMs: typeof cli.duration_ms === 'number' ? cli.duration_ms : undefined,
          numTurns: typeof cli.num_turns === 'number' ? cli.num_turns : undefined,
          costUsd: typeof cli.total_cost_usd === 'number' ? cli.total_cost_usd : undefined,
        });
      } catch {
        // Not JSON — treat raw stdout as the answer (legacy fallback, no breakdown)
        resolve({ answer: stdout.trim(), latencyMs });
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Claude CLI spawn error: ${err.message}`));
    });
  });
}

const COPILOT_PREFIX = 'copilot/';

export function isCopilotModel(model: string): boolean {
  return model.startsWith(COPILOT_PREFIX);
}

interface CopilotEvent {
  type: string;
  data?: { content?: unknown; toolRequests?: unknown[]; outputTokens?: unknown; errorType?: unknown; message?: unknown };
  usage?: { totalApiDurationMs?: unknown; premiumRequests?: unknown };
  exitCode?: unknown;
}

async function callCopilot(
  prompt: string,
  model: string,
  opts?: {
    system?: string;
    useMcp?: boolean;
    maxTurns?: number;
    mcpConfigOverride?: string;
    availableTools?: string[];
    signal?: AbortSignal;
  },
): Promise<{ answer: string; latencyMs: number; llmReportedMs?: number; numTurns?: number; costUsd?: number; outputTokens?: number }> {
  const start = Date.now();
  const copilotModel = model.slice(COPILOT_PREFIX.length);

  // The Copilot CLI has no system-prompt flag; the system instruction is
  // prepended to the user message with an explicit delimiter. Disclosed in
  // the methods section alongside the CLI mediation itself.
  const fullPrompt = opts?.system
    ? `System instructions:\n${opts.system}\n\nUser request:\n${prompt}`
    : prompt;

  const mcpConfig = opts?.mcpConfigOverride
    ?? (opts?.useMcp ? readFileSync(join(PROJECT_DIR, '.mcp.json'), 'utf-8') : '{"mcpServers":{}}');

  const args = [
    '--output-format', 'json',
    '--no-color',
    '--stream', 'off',
    '--model', copilotModel,
    '--allow-all-tools',
    '--additional-mcp-config', mcpConfig,
  ];
  // Restrict the model to exactly the approach's tool surface. A bare
  // `--available-tools` is a no-op (verified: bash stays reachable), so an
  // explicit list is mandatory. Approaches with no tools get a sentinel name
  // that matches nothing, leaving the model with zero tools — the CLI's
  // built-in shell/file tools must never be reachable during eval runs.
  const availableTools = opts?.availableTools ?? [];
  args.push(`--available-tools=${availableTools.length > 0 ? availableTools.join(',') : 'eval-no-tools-permitted'}`);
  args.push('-p', fullPrompt);

  const child = spawn(process.env.COPILOT_PATH ?? 'copilot', args, {
    cwd: PROJECT_DIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let killedByAbort = false;
  let killEscalation: NodeJS.Timeout | undefined;
  const onAbort = () => {
    killedByAbort = true;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    killEscalation = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, 2000);
  };
  if (opts?.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  return new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    let answer = '';
    let numTurns = 0;
    let outputTokens = 0;
    let llmReportedMs: number | undefined;
    let premiumRequests: number | undefined;
    let resultExitCode: number | undefined;
    let sessionError: string | undefined;

    const handleEvent = (ev: CopilotEvent) => {
      if (ev.type === 'assistant.turn_start') numTurns++;
      if (ev.type === 'assistant.message') {
        if (typeof ev.data?.content === 'string' && ev.data.content) {
          answer = ev.data.content;
        }
        if (typeof ev.data?.outputTokens === 'number') {
          outputTokens += ev.data.outputTokens;
        }
      }
      if (ev.type === 'session.error') {
        const kind = typeof ev.data?.errorType === 'string' ? ev.data.errorType : 'unknown';
        const msg = typeof ev.data?.message === 'string' ? ev.data.message : '';
        sessionError = `Copilot ${kind}: ${msg.slice(0, 200)}`;
      }
      if (ev.type === 'result') {
        if (typeof ev.usage?.totalApiDurationMs === 'number') llmReportedMs = ev.usage.totalApiDurationMs;
        if (typeof ev.usage?.premiumRequests === 'number') premiumRequests = ev.usage.premiumRequests;
        if (typeof ev.exitCode === 'number') resultExitCode = ev.exitCode;
      }
    };

    const feed = (chunk: string) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try { handleEvent(JSON.parse(line) as CopilotEvent); } catch { /* non-JSON noise */ }
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => feed(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      const latencyMs = Date.now() - start;
      if (killEscalation) clearTimeout(killEscalation);
      if (opts?.signal) opts.signal.removeEventListener('abort', onAbort);

      const tail = buffer.trim();
      if (tail) {
        try { handleEvent(JSON.parse(tail) as CopilotEvent); } catch { /* partial line */ }
      }

      if (killedByAbort) {
        reject(new Error(`Killed by abort (exit ${code}, ${latencyMs}ms elapsed)`));
        return;
      }
      if (premiumRequests != null && premiumRequests > 0) {
        console.error(`[copilot] WARNING: ${model} consumed ${premiumRequests} premium request(s) — not a 0x included model`);
      }
      if (code !== 0 || (resultExitCode != null && resultExitCode !== 0)) {
        const detail = sessionError || stderr.slice(0, 500) || answer.slice(0, 300) || '(no output)';
        reject(new Error(`Copilot CLI exit ${resultExitCode ?? code}: ${detail}`));
        return;
      }
      if (!answer.trim()) {
        reject(new Error(`Copilot CLI returned empty answer (stderr: ${stderr.slice(0, 300)})`));
        return;
      }
      resolve({
        answer: answer.trim(),
        latencyMs,
        llmReportedMs,
        numTurns: numTurns || undefined,
        outputTokens: outputTokens || undefined,
      });
    });

    child.on('error', (err) => {
      reject(new Error(`Copilot CLI spawn error: ${err.message}`));
    });
  });
}

async function callProvider(
  prompt: string,
  model: string,
  provider: Provider,
  opts?: {
    system?: string;
    useMcp?: boolean;
    maxTurns?: number;
    /** Forwarded to the underlying provider call if it supports AbortSignal. */
    signal?: AbortSignal;
  },
): Promise<{ answer: string; latencyMs: number }> {
  const start = Date.now();

  // Let errors propagate — run.ts catches them and tags result.error so
  // baselines can't silently score 0% from a swallowed connection failure.
  const response = await provider.complete({
    model,
    messages: [{ role: 'user', content: prompt }],
    system: opts?.system,
    max_tokens: 4096,
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('');

  return { answer: text.trim(), latencyMs: Date.now() - start };
}

// ─── Graph runner ────────────────────────────────────────────────────────────

export async function runGraph(q: EvalQuestion, model: string, opts?: { signal?: AbortSignal }): Promise<RunResult> {
  const provider = registry.resolve(model);
  resetMetrics();

  // Claude or Copilot: use MCP tools via the vendor CLI
  if (provider?.name === 'claude-cli' || isCopilotModel(model)) {
    // maxTurns: 20 — empirical tier-200 run showed p95=10 turns, max=17 for
    // successful questions. Previous cap of 5 was enforced by Claude CLI
    // v2.1.97 and caused ~24% of questions (esp. multi-hop and reasoning)
    // to terminate early with error_max_turns. 20 covers the full observed
    // range plus headroom while still capping runaway N+1 loops.
    const { answer, latencyMs, llmReportedMs, numTurns, costUsd, outputTokens } = await callLlm(withPatientContext(q, q.question), model, {
      system: SYSTEM_INSTRUCTION,
      useMcp: true,
      maxTurns: 20,
      availableTools: TOOL_DEFS.map((d) => `thesis-ehr-${d.function.name}`),
      signal: opts?.signal,
    });
    return {
      questionId: q.id,
      system: 'graph',
      model,
      answer,
      latencyMs,
      breakdown: buildBreakdown(latencyMs, { llmReportedMs, numTurns, costUsd, outputTokens }),
    };
  }

  // OpenRouter: OpenAI-compatible tool calling against Kuzu (--hosted path)
  if (provider?.name === 'openrouter') {
    const { answer, latencyMs, inputTokens, outputTokens, numTurns } = await callOpenRouterWithTools(
      withPatientContext(q, q.question),
      model,
      { system: SYSTEM_INSTRUCTION, maxRounds: 20, signal: opts?.signal },
    );
    return {
      questionId: q.id,
      system: 'graph',
      model,
      answer,
      latencyMs,
      breakdown: buildBreakdown(latencyMs, { inputTokens, outputTokens, numTurns }),
    };
  }

  // Ollama: use native tool calling against Kuzu. maxRounds bumped from the
  // historical 5 to 20 to match Claude — reasoning questions legitimately
  // need >5 tool-call rounds.
  const { answer, latencyMs } = await callOllamaWithTools(withPatientContext(q, q.question), model, {
    system: SYSTEM_INSTRUCTION,
    maxRounds: 20,
    signal: opts?.signal,
  });
  return {
    questionId: q.id,
    system: 'graph',
    model,
    answer,
    latencyMs,
    breakdown: buildBreakdown(latencyMs),
  };
}

// ─── Ollama tool-calling agent loop ──────────────────────────────────────────

async function callOllamaWithTools(
  prompt: string,
  model: string,
  opts: {
    system?: string;
    maxRounds?: number;
    signal?: AbortSignal;
    // Optional per-call tool set + executor. Defaults to the graph TOOL_DEFS
    // + executeTool; sql-t2s passes its own `run_sql` tool + pg executor.
    tools?: ReadonlyArray<Record<string, unknown>>;
    executor?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  },
): Promise<{ answer: string; latencyMs: number }> {
  const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  const maxRounds = opts.maxRounds ?? 5;
  const tools = opts.tools ?? TOOL_DEFS;
  const exec = opts.executor ?? executeTool;
  const start = Date.now();

  const debug = process.env.OLLAMA_DEBUG === '1';
  const messages: Array<Record<string, unknown>> = [];
  if (opts.system) {
    messages.push({ role: 'system', content: opts.system });
  }
  messages.push({ role: 'user', content: prompt });
  if (debug) console.error(`\n[DEBUG] PROMPT:\n${prompt}\n`);

  // Let errors propagate to run.ts try/catch — silent empty answers
  // hid Postgres connection failures last time as fake 0% scores.
  for (let round = 0; round < maxRounds; round++) {
    const res = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        tools,
        stream: false,
        options: { num_predict: 4096 },
      }),
      signal: opts.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama error (${res.status}): ${text}`);
    }

    const data = await res.json() as {
      message: {
        role: string;
        content: string;
        tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
      };
    };

    const toolCalls = data.message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      if (debug) console.error(`[DEBUG] FINAL (round ${round}): ${(data.message.content ?? '').slice(0, 300)}`);
      return { answer: (data.message.content ?? '').trim(), latencyMs: Date.now() - start };
    }

    // Add assistant message with tool calls
    messages.push(data.message);

    // Execute tools and add results
    for (const tc of toolCalls) {
      if (debug) console.error(`[DEBUG] CALL round=${round} ${tc.function.name}(${JSON.stringify(tc.function.arguments)})`);
      const result = await exec(tc.function.name, tc.function.arguments);
      if (debug) {
        const preview = JSON.stringify(result).slice(0, 400);
        console.error(`[DEBUG] RESULT ${tc.function.name}: ${preview}${preview.length >= 400 ? '…' : ''}`);
      }
      messages.push({ role: 'tool', content: JSON.stringify(result) });
    }
  }

  throw new Error(`Ollama agent exhausted ${maxRounds} rounds without producing a final answer`);
}

// ─── OpenRouter tool-calling agent loop ─────────────────────────────────────
//
// OpenRouter speaks the OpenAI chat/completions format. Key differences vs
// Ollama's /api/chat: (1) tool_call.function.arguments is a JSON *string*,
// not a parsed object, (2) tool results must include tool_call_id to match
// the assistant's tool_calls, (3) some models return args as an already-
// parsed object anyway, so we defensively handle both.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function stripOpenRouterPrefix(model: string): string {
  return model.startsWith('openrouter/') ? model.slice('openrouter/'.length) : model;
}

async function callOpenRouterWithTools(
  prompt: string,
  model: string,
  opts: {
    system?: string;
    maxRounds?: number;
    signal?: AbortSignal;
    tools?: ReadonlyArray<Record<string, unknown>>;
    executor?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  },
): Promise<{ answer: string; latencyMs: number; costUsd?: number; inputTokens?: number; outputTokens?: number; numTurns?: number }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set — cannot call OpenRouter');
  const maxRounds = opts.maxRounds ?? 20;
  const tools = opts.tools ?? TOOL_DEFS;
  const exec = opts.executor ?? executeTool;
  const start = Date.now();

  const debug = process.env.OPENROUTER_DEBUG === '1' || process.env.OLLAMA_DEBUG === '1';
  const routedModel = stripOpenRouterPrefix(model);

  const messages: Array<Record<string, unknown>> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: prompt });
  if (debug) console.error(`\n[DEBUG] PROMPT:\n${prompt}\n`);

  // OpenRouter doesn't surface per-call cost in the same field as Claude CLI;
  // if usage is returned we could multiply by model pricing, but for the MVP
  // we just report total_tokens so the caller can post-hoc price it.
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (let round = 0; round < maxRounds; round++) {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Title': 'ThesisBrainifai-eval',
      },
      body: JSON.stringify({
        model: routedModel,
        messages,
        tools,
        stream: false,
      }),
      signal: opts.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenRouter error (${res.status}): ${text.slice(0, 500)}`);
    }

    const data = await res.json() as {
      choices: Array<{
        message: {
          role: string;
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string | Record<string, unknown> };
          }>;
        };
        finish_reason: string | null;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    if (data.usage) {
      totalPromptTokens += data.usage.prompt_tokens ?? 0;
      totalCompletionTokens += data.usage.completion_tokens ?? 0;
    }

    const msg = data.choices?.[0]?.message;
    if (!msg) {
      throw new Error(`OpenRouter returned no choices: ${JSON.stringify(data).slice(0, 300)}`);
    }

    const toolCalls = msg.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      if (debug) {
        console.error(`[DEBUG] FINAL (round ${round}): ${(msg.content ?? '').slice(0, 300)}`);
        console.error(`[DEBUG] TOKENS prompt=${totalPromptTokens} completion=${totalCompletionTokens}`);
      }
      return {
        answer: (msg.content ?? '').trim(),
        latencyMs: Date.now() - start,
        inputTokens: totalPromptTokens || undefined,
        outputTokens: totalCompletionTokens || undefined,
        numTurns: round + 1,
      };
    }

    // Echo the assistant message back verbatim — OpenRouter requires the
    // tool_calls field match what it just sent so subsequent tool responses
    // can be threaded to the right call id.
    messages.push(msg);

    for (const tc of toolCalls) {
      let args: Record<string, unknown>;
      if (typeof tc.function.arguments === 'string') {
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          if (debug) console.error(`[DEBUG] Failed to parse args: ${tc.function.arguments.slice(0, 200)}`);
          args = {};
        }
      } else {
        args = tc.function.arguments;
      }

      if (debug) console.error(`[DEBUG] CALL round=${round} ${tc.function.name}(${JSON.stringify(args)})`);
      const result = await exec(tc.function.name, args);
      if (debug) {
        const preview = JSON.stringify(result).slice(0, 400);
        console.error(`[DEBUG] RESULT ${tc.function.name}: ${preview}${preview.length >= 400 ? '…' : ''}`);
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  throw new Error(`OpenRouter agent exhausted ${maxRounds} rounds without producing a final answer`);
}

// ─── SQL runner ──────────────────────────────────────────────────────────────

export async function runSql(q: EvalQuestion, pool: pg.Pool, model: string, opts?: { signal?: AbortSignal }): Promise<RunResult> {
  resetMetrics();
  const adapter = new SqlAdapter(pool);
  const context = await buildSqlContext(q, adapter);
  const prompt = withPatientContext(q, `Here is the relevant patient data retrieved via SQL:\n\n${context}\n\nQuestion: ${q.question}`);
  const { answer, latencyMs, llmReportedMs, numTurns, costUsd, outputTokens } = await callLlm(prompt, model, { system: SYSTEM_INSTRUCTION, signal: opts?.signal });
  return {
    questionId: q.id,
    system: 'sql',
    model,
    answer,
    latencyMs,
    breakdown: buildBreakdown(latencyMs, { llmReportedMs, numTurns, costUsd, outputTokens }),
  };
}

// ─── SQL+FTS runner ──────────────────────────────────────────────────────────

// ─── rag-dense (dense vector retrieval baseline) ─────────────────────────────
// Mirrors sql-fts scoping exactly (patient-anchored summary vs cohort listing);
// only the selection mechanism differs. Retrieval internals live in
// src/eval/retrieval.ts; index built by scripts/build-dense-index.ts.

export async function runRagDense(q: EvalQuestion, pool: pg.Pool, model: string, opts?: { signal?: AbortSignal }): Promise<RunResult> {
  resetMetrics();
  let context: string;
  if (q.type === 'cohort' || !q.patientIds || q.patientIds.length === 0) {
    const adapter = new SqlFtsAdapter(pool);
    context = await buildSqlContext(q, adapter);
  } else {
    const chunks = await denseRetrieve(q.question, q.patientIds[0], 8, opts?.signal);
    context = chunks.length > 0
      ? chunks.map((c) => `[${c.section}] ${c.text}`).join('\n\n')
      : `Patient ${q.patientIds[0]} not found in dense index.`;
  }
  const prompt = withPatientContext(q, `Here is the relevant patient data retrieved via dense vector search:\n\n${context}\n\nQuestion: ${q.question}`);
  const { answer, latencyMs, llmReportedMs, numTurns, costUsd, outputTokens } = await callLlm(prompt, model, { system: SYSTEM_INSTRUCTION, signal: opts?.signal });
  return {
    questionId: q.id,
    system: 'rag-dense',
    model,
    answer,
    latencyMs,
    breakdown: buildBreakdown(latencyMs, { llmReportedMs, numTurns, costUsd, outputTokens }),
  };
}

export async function runSqlFts(q: EvalQuestion, pool: pg.Pool, model: string, opts?: { signal?: AbortSignal }): Promise<RunResult> {
  resetMetrics();
  const adapter = new SqlFtsAdapter(pool);
  const context = await buildSqlContext(q, adapter);
  const prompt = withPatientContext(q, `Here is the relevant patient data retrieved via SQL+FTS:\n\n${context}\n\nQuestion: ${q.question}`);
  const { answer, latencyMs, llmReportedMs, numTurns, costUsd, outputTokens } = await callLlm(prompt, model, { system: SYSTEM_INSTRUCTION, signal: opts?.signal });
  return {
    questionId: q.id,
    system: 'sql-fts',
    model,
    answer,
    latencyMs,
    breakdown: buildBreakdown(latencyMs, { llmReportedMs, numTurns, costUsd, outputTokens }),
  };
}

// ─── LLM-only runner ────────────────────────────────────────────────────────

export async function runLlmOnly(q: EvalQuestion, model: string, opts?: { signal?: AbortSignal }): Promise<RunResult> {
  resetMetrics();
  let context: string;

  if (q.type === 'cohort') {
    const all = await loadAllPatientEntries({ signal: opts?.signal });
    context = buildCohortPrompt(all);
  } else if (q.patientIds.length > 0) {
    const entry = await loadPatientEntry(q.patientIds[0], { signal: opts?.signal });
    context = entry ? buildPatientPrompt(entry) : 'Patient not found.';
  } else {
    context = 'No patient data available.';
  }

  const prompt = withPatientContext(q, `Here is the patient record:\n\n${context}\n\nQuestion: ${q.question}`);
  const { answer, latencyMs, llmReportedMs, numTurns, costUsd, outputTokens } = await callLlm(prompt, model, { system: SYSTEM_INSTRUCTION, signal: opts?.signal });
  return {
    questionId: q.id,
    system: 'llm-only',
    model,
    answer,
    latencyMs,
    breakdown: buildBreakdown(latencyMs, { llmReportedMs, numTurns, costUsd, outputTokens }),
  };
}

// ─── SQL context builder ─────────────────────────────────────────────────────

export async function buildSqlContext(q: EvalQuestion, adapter: SqlAdapter): Promise<string> {
  if (q.type === 'cohort') {
    const cohort = await adapter.findCohort({});
    const lines = cohort.map(p =>
      `${p.patient_id} | ${p.first_name} ${p.last_name} | ${p.birth_date} | ${p.gender} | ${p.city}`
    );
    return `Patient cohort (${cohort.length} patients):\n${lines.join('\n')}`;
  }

  if (q.patientIds.length === 0) return 'No specific patient referenced.';

  const patientId = q.patientIds[0];
  const summary = await adapter.getPatientSummary(patientId);
  if (!summary) return `Patient ${patientId} not found.`;

  const sections: string[] = [];
  const p = summary.patient;

  sections.push(`Patient: ${p.first_name} ${p.last_name} (${p.patient_id})
Born: ${p.birth_date}, Gender: ${p.gender}, Race: ${p.race}
Location: ${p.city}, ${p.state}`);

  sections.push(`Active Conditions (${summary.conditions.filter(c => !c.stop_date).length}):
${summary.conditions.filter(c => !c.stop_date).map(c => `- ${c.description} (since ${c.start_date})`).join('\n') || 'None'}`);

  sections.push(`Medications (${summary.medications.length}):
${summary.medications.map(m => `- ${m.description} (${m.start_date}${m.stop_date ? ' to ' + m.stop_date : ' - active'})`).join('\n') || 'None'}`);

  const labsByCode = new Map<string, typeof summary.observations[0][]>();
  for (const o of summary.observations) {
    const arr = labsByCode.get(o.code) || [];
    arr.push(o);
    labsByCode.set(o.code, arr);
  }
  const labLines: string[] = [];
  // pg driver can return DATE columns as JS Date objects; stringify so the
  // descending sort and the display below don't blow up. ISO format already
  // sorts lexicographically — no numeric parsing needed.
  const asDate = (v: unknown): string => v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '');
  for (const [, obs] of labsByCode) {
    const sorted = obs.sort((a, b) => asDate(b.date).localeCompare(asDate(a.date)));
    const latest = sorted[0];
    labLines.push(`- ${latest.description}: ${latest.value} ${latest.units} (${asDate(latest.date)})`);
  }
  sections.push(`Lab Results (${labsByCode.size} types):\n${labLines.join('\n') || 'None'}`);

  sections.push(`Encounters (${summary.encounters.length}):
${summary.encounters.slice(0, 20).map(e => `- ${asDate(e.start_date)}: ${e.description} (${e.encounter_class})`).join('\n')}`);

  return sections.join('\n\n');
}

// ─── Text-to-SQL runner ──────────────────────────────────────────────────────

const SQL_T2S_SYSTEM = `You are a clinical EHR assistant with access to a PostgreSQL database via the run_sql tool.

${SCHEMA_DESC}

To answer a question: write and execute one or more SELECT queries using run_sql, then synthesise a precise answer from the results. Never guess — always query first.

If a query returns 0 rows, that is almost never the final answer. Before concluding the data is absent, try at least two alternative approaches:
- Broaden the filter (swap exact match for ILIKE '%keyword%', drop a restrictive WHERE clause, check a different date range).
- Try a different column or table — clinical concepts are frequently coded in multiple ways (description text vs SNOMED/LOINC code; observation vs procedure vs condition).
- Check if you filtered to the wrong table entirely (e.g. looking for a lab by description in the medication table).

You have up to 20 query attempts. Use them rather than giving up early.`;

const SQL_MCP_CONFIG = JSON.stringify({
  mcpServers: {
    'thesis-sql': { command: 'bash', args: ['start-mcp-sql.sh'] },
  },
});

// ─── graph-cypher (text-to-Cypher) ──────────────────────────────────────────
// Honest paradigm comparator vs sql-t2s: same model writes raw Cypher
// against the Kuzu KG instead of curated MCP tools.

const KUZU_SCHEMA_DESC = `Kuzu knowledge-graph schema — 9 node tables, 11 relationship tables:

NODE TABLES
  Patient(patient_id PK, first_name, last_name, birth_date DATE, death_date DATE|NULL,
          age_years INT64, gender, race, ethnicity, marital_status, city, state, zip)
    -- age_years is precomputed at ingest; PREFER it over computing from birth_date.

  Encounter(encounter_id PK, patient_id, provider_id, organization_id,
            encounter_class, code, description, start_date DATE, stop_date DATE,
            reason_code, reason_description)
    -- encounter_class is one of: ambulatory, wellness, outpatient, urgentcare,
    --   emergency, inpatient, hospice, home, etc. There is no "ED" class as such.

  Provider(provider_id PK, organization_id, name, gender, specialty)
  Organization(organization_id PK, name, city, state, zip, phone)

  ConceptCondition(code PK, system, description)        -- shared across patients
  ConceptMedication(code PK, description)
  ConceptObservation(code PK, description, category, units, type,
                     canonical_unit, normal_low DOUBLE, normal_high DOUBLE,
                     critical_low DOUBLE, critical_high DOUBLE, range_source)
    -- LOINC-coded labs. normal_low/high allow flagging abnormal values.
  ConceptProcedure(code PK, system, description)

REL TABLES (FROM → TO with properties)
  (Patient)-[DIAGNOSED_WITH {start_date DATE, stop_date DATE|NULL, encounter_id}]->(ConceptCondition)
    -- stop_date IS NULL means active condition.
  (Patient)-[PRESCRIBED {start_date, stop_date|NULL, encounter_id, reason_code, reason_description}]->(ConceptMedication)
    -- stop_date IS NULL means active medication.
  (Patient)-[HAS_RESULT {value STRING, units, value_canonical DOUBLE|NULL, units_canonical, date DATE, encounter_id, category, type}]->(ConceptObservation)
    -- Use value_canonical for numeric aggregation; fall back to value::float when null.
    -- "category" can be "laboratory", "vital-signs", "survey", etc.
  (Patient)-[UNDERWENT {start_date, stop_date, encounter_id, reason_code, reason_description}]->(ConceptProcedure)
  (Patient)-[HAD_ENCOUNTER]->(Encounter)
  (Encounter)-[TREATED_BY]->(Provider)
  (Encounter)-[AT_ORGANIZATION]->(Organization)
  (Encounter)-[REASON_FOR]->(ConceptCondition)
  (Provider)-[AFFILIATED_WITH]->(Organization)
  (ConceptMedication)-[TREATS]->(ConceptCondition)
  (ConceptProcedure)-[INDICATED_BY]->(ConceptCondition)
  (ConceptCondition)-[COMPLICATION_OF]->(ConceptCondition)

KUZU CYPHER NOTES
- Cypher dialect: standard MATCH / WHERE / RETURN / WITH / ORDER BY / LIMIT.
- String matching: CONTAINS is CASE-SENSITIVE. Use lower(s) CONTAINS lower('...')
  for case-insensitive partial match. STARTS WITH / ENDS WITH also work.
- Dates are real DATE values; comparisons (>=, <=, <, >) and ORDER BY work.
  Compare against ISO strings cast via DATE('2024-01-01') if needed.
- Aggregation: COUNT(DISTINCT p), AVG, MIN, MAX, SUM. Use COUNT(DISTINCT p) for
  cohort sizing, never COUNT(*) (each patient may have multiple matching rows).
- Use property access via the relationship variable for properties on the rel,
  e.g. MATCH (p:Patient)-[d:DIAGNOSED_WITH]->(c:ConceptCondition) WHERE d.stop_date IS NULL.
- LIMIT results to ≤100 rows unless the question specifically asks for a count.
- Read-only: CREATE/MERGE/DELETE/SET/REMOVE/DROP are blocked by the executor.`;

const CYPHER_T2S_SYSTEM = `You are a clinical EHR assistant with access to the Kuzu knowledge graph via the run_cypher tool.

${KUZU_SCHEMA_DESC}

To answer a question: write and execute one or more read-only Cypher MATCH queries using run_cypher, then synthesise a precise answer from the results. Never guess — always query first.

If a query returns 0 rows, that is almost never the final answer. Before concluding the data is absent, try at least two alternative approaches:
- Broaden the filter (swap exact match for lower(s) CONTAINS lower('keyword'), drop a restrictive WHERE clause, check a different date range).
- Try a different relationship or node type — clinical concepts are frequently coded in multiple ways (description text vs SNOMED/LOINC code; ConceptCondition vs ConceptProcedure vs ConceptObservation).
- Check if you filtered to the wrong relationship entirely (e.g. asking for labs via DIAGNOSED_WITH when you should use HAS_RESULT).

You have up to 20 query attempts. Use them rather than giving up early.`;

const CYPHER_MCP_CONFIG = JSON.stringify({
  mcpServers: {
    'thesis-cypher': { command: 'bash', args: ['start-mcp-cypher.sh'] },
  },
});

// Cypher tool def for OpenRouter / Ollama paths (parallel to RUN_SQL_TOOL).
const RUN_CYPHER_TOOL: ReadonlyArray<Record<string, unknown>> = [
  {
    type: 'function',
    function: {
      name: 'run_cypher',
      description: 'Execute a read-only Cypher query against the EHR knowledge graph and return rows. Only MATCH/RETURN/WITH/CALL queries; CREATE/MERGE/DELETE/SET/REMOVE/DROP are rejected.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A read-only Cypher query (Kuzu dialect).' },
        },
        required: ['query'],
      },
    },
  },
];

// Read-only guard mirrors the MCP server (src/mcp-cypher/index.ts).
const CYPHER_FORBIDDEN = /\b(CREATE|MERGE|DELETE|SET|REMOVE|DETACH|DROP|COPY|INSTALL|LOAD|ATTACH|CHECKPOINT|BEGIN|COMMIT|ROLLBACK)\b/i;

function buildCypherExecutor() {
  return async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const start = metricsEnabled() ? Date.now() : 0;
    const finish = () => { if (metricsEnabled()) recordTool(name, Date.now() - start); };

    if (name !== 'run_cypher') { finish(); return { error: `Unknown tool: ${name}` }; }
    const query = String(args.query ?? '').trim();
    if (!query) { finish(); return { error: 'Missing query argument.' }; }
    if (CYPHER_FORBIDDEN.test(query)) {
      finish();
      return { error: 'Query contains disallowed keywords. Only read-only Cypher is allowed.' };
    }

    try {
      const { withLock: kLock, getConnection: kConn } = await import('../api/kuzu-client.js');
      const rows = await kLock(async () => {
        const c = await kConn();
        const result = await c.query(query);
        return (await result.getAll()) as Record<string, unknown>[];
      });
      const capped = rows.slice(0, 100);
      finish();
      return { row_count: rows.length, rows: capped, truncated: rows.length > 100 };
    } catch (err) {
      finish();
      return { error: `Query failed: ${(err as Error).message}` };
    }
  };
}

export async function runGraphCypher(q: EvalQuestion, model: string, opts?: { signal?: AbortSignal }): Promise<RunResult> {
  resetMetrics();
  const provider = registry.resolve(model);

  // Claude/Copilot path — uses the MCP run_cypher tool via start-mcp-cypher.sh
  if (provider?.name === 'claude-cli' || isCopilotModel(model)) {
    const { answer, latencyMs, llmReportedMs, numTurns, costUsd, outputTokens } = await callLlm(withPatientContext(q, q.question), model, {
      system: CYPHER_T2S_SYSTEM,
      mcpConfigOverride: CYPHER_MCP_CONFIG,
      availableTools: ['thesis-cypher-run_cypher'],
      maxTurns: 20,
      signal: opts?.signal,
    });
    return {
      questionId: q.id, system: 'graph-cypher', model,
      answer, latencyMs,
      breakdown: buildBreakdown(latencyMs, { llmReportedMs, numTurns, costUsd, outputTokens }),
    };
  }

  // OpenRouter path
  if (provider?.name === 'openrouter') {
    const { answer, latencyMs, inputTokens, outputTokens, numTurns } = await callOpenRouterWithTools(
      withPatientContext(q, q.question),
      model,
      {
        system: CYPHER_T2S_SYSTEM,
        maxRounds: 20,
        signal: opts?.signal,
        tools: RUN_CYPHER_TOOL,
        executor: buildCypherExecutor(),
      },
    );
    return { questionId: q.id, system: 'graph-cypher', model, answer, latencyMs, breakdown: buildBreakdown(latencyMs, { inputTokens, outputTokens, numTurns }) };
  }

  // Ollama path
  const { answer, latencyMs } = await callOllamaWithTools(
    withPatientContext(q, q.question),
    model,
    {
      system: CYPHER_T2S_SYSTEM,
      maxRounds: 20,
      signal: opts?.signal,
      tools: RUN_CYPHER_TOOL,
      executor: buildCypherExecutor(),
    },
  );
  return { questionId: q.id, system: 'graph-cypher', model, answer, latencyMs, breakdown: buildBreakdown(latencyMs) };
}

// Shared SQL tool definition used by both Ollama (native) and OpenRouter
// (OpenAI-format) paths. The MCP `run_sql` tool in src/mcp-sql/index.ts is the
// Claude-side mirror of this — keep them in sync.
const RUN_SQL_TOOL: ReadonlyArray<Record<string, unknown>> = [
  {
    type: 'function',
    function: {
      name: 'run_sql',
      description: 'Execute a SELECT query against the EHR PostgreSQL database and return the rows. Only SELECT queries are allowed; DROP/DELETE/INSERT/UPDATE/etc. are rejected.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A PostgreSQL SELECT query.' },
        },
        required: ['query'],
      },
    },
  },
];

// SELECT-only guard — mirrors the MCP server (src/mcp-sql/index.ts). Same
// keyword list so Claude-MCP and Ollama/OpenRouter paths reject the same
// queries. Defense in depth: we also run as a DB user with read-only grants
// in practice.
const SQL_FORBIDDEN = /\b(DROP|DELETE|INSERT|UPDATE|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i;

function buildSqlExecutor(pool: pg.Pool) {
  return async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    // Record each call through the shared metrics recorder so
    // breakdown.toolCalls reflects sql-t2s work too. Previously only
    // graph-side executeTool() went through recordTool, leaving sql-t2s
    // cells looking like zero-tool-call runs.
    const start = metricsEnabled() ? Date.now() : 0;
    const finish = () => { if (metricsEnabled()) recordTool(name, Date.now() - start); };

    if (name !== 'run_sql') { finish(); return { error: `Unknown tool: ${name}` }; }
    const query = String(args.query ?? '').trim();
    if (!query) { finish(); return { error: 'Missing query argument.' }; }
    if (!query.toUpperCase().trimStart().startsWith('SELECT')) {
      finish();
      return { error: 'Only SELECT queries are allowed.' };
    }
    if (SQL_FORBIDDEN.test(query)) {
      finish();
      return { error: 'Query contains disallowed keywords.' };
    }
    try {
      const { rows } = await pool.query(query);
      // Cap at 100 rows to keep the tool response size bounded — matches the
      // Claude MCP mirror (src/mcp-sql/index.ts:formatRows).
      const capped = rows.slice(0, 100);
      finish();
      return {
        row_count: rows.length,
        rows: capped,
        truncated: rows.length > 100,
      };
    } catch (err) {
      finish();
      return { error: `Query failed: ${(err as Error).message}` };
    }
  };
}

export async function runSqlT2S(q: EvalQuestion, pool: pg.Pool, model: string, opts?: { signal?: AbortSignal }): Promise<RunResult> {
  resetMetrics();
  const provider = registry.resolve(model);

  // Claude/Copilot path — uses the MCP run_sql tool via start-mcp-sql.sh
  if (provider?.name === 'claude-cli' || isCopilotModel(model)) {
    const { answer, latencyMs, llmReportedMs, numTurns, costUsd, outputTokens } = await callLlm(withPatientContext(q, q.question), model, {
      system: SQL_T2S_SYSTEM,
      mcpConfigOverride: SQL_MCP_CONFIG,
      availableTools: ['thesis-sql-run_sql'],
      maxTurns: 20,
      signal: opts?.signal,
    });
    return {
      questionId: q.id, system: 'sql-t2s', model,
      answer, latencyMs,
      breakdown: buildBreakdown(latencyMs, { llmReportedMs, numTurns, costUsd, outputTokens }),
    };
  }

  // OpenRouter path — OpenAI-format tool calling against our in-process run_sql executor
  if (provider?.name === 'openrouter') {
    const { answer, latencyMs, inputTokens, outputTokens, numTurns } = await callOpenRouterWithTools(
      withPatientContext(q, q.question),
      model,
      {
        system: SQL_T2S_SYSTEM,
        maxRounds: 20,
        signal: opts?.signal,
        tools: RUN_SQL_TOOL,
        executor: buildSqlExecutor(pool),
      },
    );
    return { questionId: q.id, system: 'sql-t2s', model, answer, latencyMs, breakdown: buildBreakdown(latencyMs, { inputTokens, outputTokens, numTurns }) };
  }

  // Ollama path — native tool calling against the same in-process run_sql
  // executor. Replaces the prior single-turn schema-in-prompt fallback, which
  // produced unexecutable SQL strings as answers (see SL-19 tier-200 probe).
  const { answer, latencyMs } = await callOllamaWithTools(
    withPatientContext(q, q.question),
    model,
    {
      system: SQL_T2S_SYSTEM,
      maxRounds: 20,
      signal: opts?.signal,
      tools: RUN_SQL_TOOL,
      executor: buildSqlExecutor(pool),
    },
  );
  return { questionId: q.id, system: 'sql-t2s', model, answer, latencyMs, breakdown: buildBreakdown(latencyMs) };
}
