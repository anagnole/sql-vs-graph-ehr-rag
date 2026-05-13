/**
 * Lightweight in-process timing accumulators for the eval runner.
 *
 * Captures Kuzu query + tool execution timings on the Ollama path
 * (where tools run in-process). For the Claude path, tools execute in the
 * Brainifai MCP subprocess and these accumulators stay empty — use
 * cli.duration_ms / cli.num_turns from the Claude CLI output instead.
 *
 * Enable via env var: BRAINIFAI_METRICS=1
 */
interface MetricsWindow {
  kuzuMs: number;
  kuzuCalls: number;
  lockWaitMs: number;
  toolMs: number;
  toolCalls: number;
  perTool: Record<string, { ms: number; calls: number }>;
}

let window: MetricsWindow = newWindow();

function newWindow(): MetricsWindow {
  return { kuzuMs: 0, kuzuCalls: 0, lockWaitMs: 0, toolMs: 0, toolCalls: 0, perTool: {} };
}

// Read env on each call so callers can flip the flag after module import
// (run.ts sets it inside main(), which runs after this file is loaded).
export function metricsEnabled(): boolean {
  return process.env.BRAINIFAI_METRICS === "1";
}

export function recordKuzu(lockWaitMs: number, queryMs: number): void {
  if (!metricsEnabled()) return;
  window.kuzuMs += queryMs;
  window.lockWaitMs += lockWaitMs;
  window.kuzuCalls += 1;
}

export function recordTool(name: string, ms: number): void {
  if (!metricsEnabled()) return;
  window.toolMs += ms;
  window.toolCalls += 1;
  const e = window.perTool[name] ?? { ms: 0, calls: 0 };
  e.ms += ms;
  e.calls += 1;
  window.perTool[name] = e;
}

export function resetMetrics(): void {
  window = newWindow();
}

export function getMetrics(): MetricsWindow {
  return {
    kuzuMs: Math.round(window.kuzuMs),
    kuzuCalls: window.kuzuCalls,
    lockWaitMs: Math.round(window.lockWaitMs),
    toolMs: Math.round(window.toolMs),
    toolCalls: window.toolCalls,
    perTool: Object.fromEntries(
      Object.entries(window.perTool).map(([k, v]) => [k, { ms: Math.round(v.ms), calls: v.calls }]),
    ),
  };
}
