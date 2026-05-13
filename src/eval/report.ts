/**
 * Report generator — produces summary.md, summary.json, and per-question.csv
 * from scored evaluation results.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalQuestion, ScoredResult, SystemSummary } from './types.js';

const RESULTS_DIR = join(import.meta.dirname, '../../results');

export function generateReport(
  questions: EvalQuestion[],
  results: ScoredResult[],
): void {
  mkdirSync(RESULTS_DIR, { recursive: true });

  const systems = ['graph', 'sql', 'sql-fts', 'llm-only'] as const;
  const types = ['simple-lookup', 'multi-hop', 'temporal', 'cohort', 'reasoning', 'unanswerable'] as const;
  const hasJudgeScores = results.some(r => r.judgeScore != null && r.judgeScore >= 0);

  // ─── Build summaries ─────────────────────────────────────────────────

  const summaries: SystemSummary[] = systems.map((sys) => {
    const sysResults = results.filter(r => r.system === sys);
    const scores = sysResults.filter(r => !r.error).map(r => r.score);
    const overall = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

    const byType: Record<string, number> = {};
    for (const type of types) {
      const typeResults = sysResults.filter(r => {
        const q = questions.find(q => q.id === r.questionId);
        return q?.type === type;
      });
      const typeScores = typeResults.filter(r => !r.error).map(r => r.score);
      byType[type] = typeScores.length > 0 ? typeScores.reduce((a, b) => a + b, 0) / typeScores.length : 0;
    }

    const domains = [...new Set(questions.map(q => q.domain))];
    const byDomain: Record<string, number> = {};
    for (const domain of domains) {
      const domainQIds = new Set(questions.filter(q => q.domain === domain).map(q => q.id));
      const domainResults = sysResults.filter(r => domainQIds.has(r.questionId));
      const domainScores = domainResults.filter(r => !r.error).map(r => r.score);
      byDomain[domain] = domainScores.length > 0 ? domainScores.reduce((a, b) => a + b, 0) / domainScores.length : 0;
    }

    return {
      system: sys,
      overall: Math.round(overall * 1000) / 1000,
      byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
      byDomain: Object.fromEntries(Object.entries(byDomain).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
      avgLatencyMs: Math.round(sysResults.reduce((a, r) => a + r.latencyMs, 0) / (sysResults.length || 1)),
      errorCount: sysResults.filter(r => r.error).length,
    };
  });

  // ─── summary.json ────────────────────────────────────────────────────

  writeFileSync(
    join(RESULTS_DIR, 'summary.json'),
    JSON.stringify({ summaries, results }, null, 2),
  );

  // ─── summary.md ──────────────────────────────────────────────────────

  const md: string[] = ['# Evaluation Results\n'];

  // Overall comparison table
  md.push('## Overall Scores\n');
  md.push('| System | Score | Avg Latency | Errors |');
  md.push('|--------|-------|-------------|--------|');
  for (const s of summaries) {
    md.push(`| ${s.system} | ${(s.overall * 100).toFixed(1)}% | ${s.avgLatencyMs}ms | ${s.errorCount} |`);
  }

  // By question type
  md.push('\n## Scores by Question Type\n');
  md.push(`| System | ${types.join(' | ')} |`);
  md.push(`|--------|${types.map(() => '------').join('|')}|`);
  for (const s of summaries) {
    const vals = types.map(t => `${((s.byType[t] ?? 0) * 100).toFixed(1)}%`);
    md.push(`| ${s.system} | ${vals.join(' | ')} |`);
  }

  // By domain (top domains)
  const allDomains = [...new Set(questions.map(q => q.domain))].sort();
  md.push('\n## Scores by Domain\n');
  md.push(`| System | ${allDomains.join(' | ')} |`);
  md.push(`|--------|${allDomains.map(() => '------').join('|')}|`);
  for (const s of summaries) {
    const vals = allDomains.map(d => `${((s.byDomain[d] ?? 0) * 100).toFixed(1)}%`);
    md.push(`| ${s.system} | ${vals.join(' | ')} |`);
  }

  writeFileSync(join(RESULTS_DIR, 'summary.md'), md.join('\n'));

  // ─── per-question.csv ────────────────────────────────────────────────

  const csvHeader = [
    'question_id', 'type', 'domain', 'system', 'score', 'score_method',
    'latency_ms', 'kuzu_ms', 'kuzu_calls', 'lock_wait_ms', 'tool_ms', 'tool_calls',
    'llm_reported_ms', 'num_turns', 'cost_usd',
    ...(hasJudgeScores ? ['judge_score', 'judge_rationale'] : []),
    'error',
  ];
  const csvLines = [csvHeader.join(',')];
  for (const r of results) {
    const q = questions.find(q => q.id === r.questionId);
    const b = r.breakdown;
    const row = [
      r.questionId,
      q?.type ?? '',
      q?.domain ?? '',
      r.system,
      r.score.toFixed(3),
      r.scoreMethod,
      r.latencyMs,
      b?.kuzuMs ?? '',
      b?.kuzuCalls ?? '',
      b?.lockWaitMs ?? '',
      b?.toolMs ?? '',
      b?.toolCalls ?? '',
      b?.llmReportedMs ?? '',
      b?.numTurns ?? '',
      b?.costUsd != null ? b.costUsd.toFixed(6) : '',
      ...(hasJudgeScores ? [
        r.judgeScore != null ? r.judgeScore.toFixed(3) : '',
        r.judgeRationale ? `"${r.judgeRationale.replace(/"/g, '""')}"` : '',
      ] : []),
      r.error ? `"${r.error.replace(/"/g, '""')}"` : '',
    ];
    csvLines.push(row.join(','));
  }
  writeFileSync(join(RESULTS_DIR, 'per-question.csv'), csvLines.join('\n'));

  console.log(`Reports written to ${RESULTS_DIR}/`);
  console.log(`  summary.json  — full structured results`);
  console.log(`  summary.md    — comparison tables`);
  console.log(`  per-question.csv — for statistical analysis`);
}
