/**
 * Post-hoc statistical analysis of eval results.
 *
 * Computes, given one or more incremental result files:
 *   - Per-system accuracy + bootstrap 95% CI
 *   - Pairwise McNemar's test (paired binary correctness on same questions)
 *   - Per-type accuracy breakdown
 *   - Cochran's Q across tiers (if multiple files given)
 *
 * Usage:
 *   # Within-tier paired comparison
 *   npx tsx scripts/stats.ts results/incremental-claude-haiku-4-5-20251001-tier-200.json
 *
 *   # Across-tier scaling comparison (Cochran's Q)
 *   npx tsx scripts/stats.ts \
 *     results/incremental-claude-haiku-4-5-20251001-tier-200.json \
 *     results/incremental-claude-haiku-4-5-20251001-tier-2000.json \
 *     results/incremental-claude-haiku-4-5-20251001-tier-20000.json
 *
 *   # Strict binary (score == 1.0, no partial credit)
 *   npx tsx scripts/stats.ts --strict <file>
 *
 *   # Custom bootstrap iterations
 *   npx tsx scripts/stats.ts --boot 5000 <file>
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ScoredResult } from "../src/eval/types.js";

const CORRECTNESS_THRESHOLD_DEFAULT = 0.5;
const BOOTSTRAP_ITERS_DEFAULT = 2000;

// ─── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const threshold = strict ? 1.0 : CORRECTNESS_THRESHOLD_DEFAULT;
  const bootIdx = args.indexOf("--boot");
  const bootIters = bootIdx >= 0 ? parseInt(args[bootIdx + 1]) : BOOTSTRAP_ITERS_DEFAULT;
  const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--boot");

  if (files.length === 0) {
    console.error("Usage: npx tsx scripts/stats.ts [--strict] [--boot N] <file1.json> [file2.json ...]");
    process.exit(1);
  }

  const datasets = files.map((f) => ({
    label: deriveLabel(f),
    results: JSON.parse(readFileSync(f, "utf-8")) as ScoredResult[],
  }));

  console.log(`Correctness threshold: score >= ${threshold}`);
  console.log(`Bootstrap iterations: ${bootIters}\n`);

  for (const d of datasets) {
    console.log(`\n══ ${d.label} ${"═".repeat(Math.max(0, 70 - d.label.length))}`);
    reportAccuracy(d.results, threshold, bootIters);
    reportPairwise(d.results, threshold);
  }

  if (datasets.length >= 2) {
    console.log(`\n══ Cross-tier scaling (Cochran's Q) ${"═".repeat(40)}`);
    reportCochran(datasets, threshold);
  }
}

// ─── Per-system accuracy + bootstrap CI ───────────────────────────────────────

function reportAccuracy(results: ScoredResult[], threshold: number, iters: number) {
  const bySystem = groupBy(results, (r) => r.system);
  const types = [...new Set(results.map((r) => r.system && (r as any).type).filter(Boolean))];

  const byQType = groupBy(results, (r: any) => r.type ?? "unknown");

  console.log(`\nPer-system accuracy (95% bootstrap CI):`);
  const systems = [...bySystem.keys()].sort();
  for (const sys of systems) {
    const rs = bySystem.get(sys)!;
    const acc = meanCorrect(rs, threshold);
    const ci = bootstrapCI(rs, threshold, iters);
    console.log(`  ${sys.padEnd(10)} ${(acc * 100).toFixed(1)}%  [${(ci.lo * 100).toFixed(1)}, ${(ci.hi * 100).toFixed(1)}]  n=${rs.length}`);
  }

  // Per-type breakdown
  const typeLabels = [...new Set(results.map((r: any) => r.type).filter(Boolean))].sort();
  if (typeLabels.length > 0) {
    console.log(`\nPer-type accuracy:`);
    const header = "  type".padEnd(18) + systems.map((s) => s.padStart(10)).join("  ");
    console.log(header);
    for (const t of typeLabels) {
      const row = `  ${t}`.padEnd(18);
      const cells = systems.map((sys) => {
        const rs = (bySystem.get(sys) ?? []).filter((r: any) => r.type === t);
        if (rs.length === 0) return "—".padStart(10);
        const acc = meanCorrect(rs, threshold);
        return `${(acc * 100).toFixed(1)}%`.padStart(10);
      });
      console.log(row + cells.join("  "));
    }
  }
}

// ─── Pairwise McNemar's test ────────────────────────────────────────────────

function reportPairwise(results: ScoredResult[], threshold: number) {
  const bySystem = groupBy(results, (r) => r.system);
  const systems = [...bySystem.keys()].sort();
  if (systems.length < 2) return;

  console.log(`\nPairwise McNemar's test (paired binary correctness):`);
  console.log(`  Pair                         b    c    chi2    p-value     direction`);
  for (let i = 0; i < systems.length; i++) {
    for (let j = i + 1; j < systems.length; j++) {
      const a = systems[i];
      const b = systems[j];
      const pair = pairByQuestion(bySystem.get(a)!, bySystem.get(b)!, threshold);
      const res = mcnemar(pair);
      const dir = res.b > res.c ? `${a} > ${b}` : res.c > res.b ? `${b} > ${a}` : "tie";
      const pstr = res.p < 0.001 ? "<0.001" : res.p.toFixed(4);
      console.log(
        `  ${(a + " vs " + b).padEnd(30)} ${String(res.b).padStart(3)}  ${String(res.c).padStart(3)}  ${res.chi2.toFixed(2).padStart(6)}  ${pstr.padStart(8)}    ${dir}`,
      );
    }
  }
}

// ─── Cochran's Q (k related groups) ──────────────────────────────────────────

function reportCochran(
  datasets: { label: string; results: ScoredResult[] }[],
  threshold: number,
) {
  // For each system, test whether accuracy differs across tiers on the same questions.
  const allSystems = new Set<string>();
  for (const d of datasets) for (const r of d.results) allSystems.add(r.system);

  console.log(`  System      k-tiers  Q       df    p-value`);
  for (const sys of [...allSystems].sort()) {
    // Collect paired (per-question) binary correctness across datasets for this system
    const perDataset = datasets.map((d) => d.results.filter((r) => r.system === sys));
    if (perDataset.some((rs) => rs.length === 0)) continue;

    // Intersect question IDs
    const idSets = perDataset.map((rs) => new Set(rs.map((r) => r.questionId)));
    const common = [...idSets[0]].filter((id) => idSets.every((s) => s.has(id)));
    if (common.length < 5) continue;

    // Build matrix [question × tier] → {0, 1}
    const matrix: number[][] = common.map((qid) =>
      perDataset.map((rs) => binarize(rs.find((r) => r.questionId === qid)!, threshold)),
    );

    const res = cochranQ(matrix);
    const pstr = res.p < 0.001 ? "<0.001" : res.p.toFixed(4);
    console.log(
      `  ${sys.padEnd(10)}  ${String(datasets.length).padStart(7)}  ${res.q.toFixed(2).padStart(5)}   ${String(res.df).padStart(2)}    ${pstr.padStart(7)}`,
    );
  }
}

// ─── Statistical primitives ──────────────────────────────────────────────────

function binarize(r: ScoredResult, threshold: number): number {
  if (r.error) return 0;
  return (r.score ?? 0) >= threshold ? 1 : 0;
}

function meanCorrect(rs: ScoredResult[], threshold: number): number {
  if (rs.length === 0) return 0;
  let s = 0;
  for (const r of rs) s += binarize(r, threshold);
  return s / rs.length;
}

function bootstrapCI(
  rs: ScoredResult[],
  threshold: number,
  iters: number,
  alpha = 0.05,
): { lo: number; hi: number } {
  const n = rs.length;
  if (n === 0) return { lo: 0, hi: 0 };
  const bin = rs.map((r) => binarize(r, threshold));
  const means: number[] = new Array(iters);
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += bin[(Math.random() * n) | 0];
    means[i] = s / n;
  }
  means.sort((x, y) => x - y);
  return {
    lo: means[Math.floor((alpha / 2) * iters)],
    hi: means[Math.floor((1 - alpha / 2) * iters)],
  };
}

/**
 * Pair results from two systems by questionId. Only includes questions scored
 * by both systems.
 */
function pairByQuestion(a: ScoredResult[], b: ScoredResult[], threshold: number) {
  const bByQ = new Map(b.map((r) => [r.questionId, r]));
  const pairs: { a: number; b: number }[] = [];
  for (const ra of a) {
    const rb = bByQ.get(ra.questionId);
    if (!rb) continue;
    pairs.push({ a: binarize(ra, threshold), b: binarize(rb, threshold) });
  }
  return pairs;
}

/**
 * McNemar's test with continuity correction.
 * Returns { b, c, chi2, p } where:
 *   b = pairs where A correct, B wrong
 *   c = pairs where A wrong, B correct
 */
function mcnemar(pairs: { a: number; b: number }[]): {
  b: number;
  c: number;
  chi2: number;
  p: number;
} {
  let b = 0, c = 0;
  for (const p of pairs) {
    if (p.a === 1 && p.b === 0) b++;
    else if (p.a === 0 && p.b === 1) c++;
  }
  const n = b + c;
  if (n === 0) return { b, c, chi2: 0, p: 1 };
  const chi2 = ((Math.abs(b - c) - 1) ** 2) / n;
  // 1-df chi-squared survival function via Wilson-Hilferty approximation:
  // more robust: use complementary error function approximation
  const p = chi2SurvivalDf1(chi2);
  return { b, c, chi2, p };
}

/**
 * Cochran's Q test for k related binary samples.
 * matrix[i][j] = subject i, condition j; entry in {0, 1}.
 */
function cochranQ(matrix: number[][]): { q: number; df: number; p: number } {
  const n = matrix.length;
  const k = matrix[0]?.length ?? 0;
  if (n === 0 || k < 2) return { q: 0, df: 0, p: 1 };

  const colTotals = new Array(k).fill(0);
  const rowTotals = new Array(n).fill(0);
  let grand = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < k; j++) {
      colTotals[j] += matrix[i][j];
      rowTotals[i] += matrix[i][j];
      grand += matrix[i][j];
    }
  }

  const sumColSq = colTotals.reduce((s, x) => s + x * x, 0);
  const sumRowSq = rowTotals.reduce((s, x) => s + x * x, 0);
  const numer = (k - 1) * (k * sumColSq - grand * grand);
  const denom = k * grand - sumRowSq;
  const q = denom === 0 ? 0 : numer / denom;
  const df = k - 1;
  const p = chi2SurvivalDfK(q, df);
  return { q, df, p };
}

// ─── Chi-squared survival approximations ─────────────────────────────────────

function chi2SurvivalDf1(x: number): number {
  if (x <= 0) return 1;
  return erfc(Math.sqrt(x / 2));
}

function chi2SurvivalDfK(x: number, k: number): number {
  if (x <= 0 || k < 1) return 1;
  if (k === 1) return chi2SurvivalDf1(x);
  // Regularized upper incomplete gamma Q(k/2, x/2)
  return gammaQ(k / 2, x / 2);
}

function erfc(x: number): number {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const y =
    t *
    Math.exp(
      -x * x -
        1.26551223 +
        t * (1.00002368 +
        t * (0.37409196 +
        t * (0.09678418 +
        t * (-0.18628806 +
        t * (0.27886807 +
        t * (-1.13520398 +
        t * (1.48851587 +
        t * (-0.82215223 +
        t * 0.17087277))))))))
    );
  return x >= 0 ? y : 2 - y;
}

function gammaQ(a: number, x: number): number {
  if (x < 0 || a <= 0) return 1;
  if (x === 0) return 1;
  if (x < a + 1) return 1 - gammaSeries(a, x);
  return gammaCF(a, x);
}

function logGamma(x: number): number {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function gammaSeries(a: number, x: number): number {
  const ITMAX = 200;
  const EPS = 3e-7;
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 1; n <= ITMAX; n++) {
    ap++;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) {
      return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
    }
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function gammaCF(a: number, x: number): number {
  const ITMAX = 200;
  const EPS = 3e-7;
  const FPMIN = 1e-30;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function groupBy<T, K>(arr: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of arr) {
    const k = key(x);
    const list = m.get(k) ?? [];
    list.push(x);
    m.set(k, list);
  }
  return m;
}

function deriveLabel(filepath: string): string {
  const base = basename(filepath).replace(/\.json$/, "").replace(/^incremental-/, "");
  return base;
}

main();
