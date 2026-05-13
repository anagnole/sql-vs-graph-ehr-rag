/**
 * Evaluation types — shared across runners, scorers, and report generator.
 */

export interface EvalQuestion {
  id: string;
  type: 'simple-lookup' | 'multi-hop' | 'temporal' | 'cohort' | 'reasoning' | 'negation' | 'unanswerable';
  question: string;
  answer: string;
  patientIds: string[];
  domain: string;
  supportingRecordIds: string[];
}

export interface RunResult {
  questionId: string;
  system: 'graph' | 'sql' | 'sql-fts' | 'sql-t2s' | 'llm-only' | 'graph-cypher';
  model: string;
  answer: string;
  latencyMs: number;
  error?: string;
  /**
   * Optional per-stage timing breakdown. Populated when BRAINIFAI_METRICS=1.
   *
   * For the Ollama in-process tool path, kuzuMs / lockWaitMs / toolMs are
   * captured directly. For the Claude+MCP path, only llmReportedMs / numTurns
   * are populated (tools run in a subprocess we don't instrument).
   */
  breakdown?: {
    totalMs: number;
    kuzuMs?: number;
    kuzuCalls?: number;
    lockWaitMs?: number;
    toolMs?: number;
    toolCalls?: number;
    perTool?: Record<string, { ms: number; calls: number }>;
    llmReportedMs?: number;
    numTurns?: number;
    /** Total USD cost for this question, parsed from Claude CLI's total_cost_usd field. Undefined for local/Ollama models. */
    costUsd?: number;
  };
}

export interface ScoredResult extends RunResult {
  score: number;          // 0-1 primary score
  scoreMethod: string;    // how it was scored
  groundTruth: string;
  /** LLM-as-judge score (0-1), populated by the judge pass */
  judgeScore?: number;
  /** Brief rationale from the judge */
  judgeRationale?: string;
}

export interface SystemSummary {
  system: string;
  overall: number;
  byType: Record<string, number>;
  byDomain: Record<string, number>;
  avgLatencyMs: number;
  errorCount: number;
}
