# Paradigm Comparison — Statistical Analysis Bundle

Generated **2026-05-11** from 13,640 judged cells across 3 models × 3 tiers × 5 retrieval paradigms × 6 question types.

## What's in this bundle

```
ANALYSIS.pdf              ← the writeup (read this first)
README.md                 ← this file
plots/                    ← every PNG referenced in the PDF (150 DPI)
tables/                   ← every statistical test result as CSV
  long_format.csv           ← master file: one row per judged cell
  1_descriptive_means.csv   ← system means + 95% bootstrap CIs
  2_friedman.csv            ← Friedman omnibus per (model, tier)
  3_pairwise_wilcoxon.csv   ← Wilcoxon + Cliff's δ + Bonferroni p
  3b_cochran_q.csv          ← Cochran's Q omnibus (strict + lenient)
  3c_mcnemar_pairs.csv      ← pairwise McNemar with b/c counts
  4_scaling_regression.csv  ← log-tier slopes per (model, system)
  5_type_system_means.csv   ← mean judge per (model, type, system)
  6_fuzzy_judge_agreement.csv ← Spearman + κ per model
  8_flag_rates.csv          ← gt_suspect + over_answered rates
  9_cross_model_friedman.csv ← Friedman across models per (system, tier)
  10_top_summary.csv        ← top-line summary (§2 of PDF)
  15_best_paradigm_per_model.csv
  16_best_system_per_type.csv
  17_gt_flagged_questions.csv
judge-rubric.md           ← the rubric used by the LLM-as-judge
```

## How to reproduce

```bash
# from the repo root
.venv-analysis/bin/python scripts/analysis_v2.py
# regenerates docs/analysis/v2/ANALYSIS.md + plots/ + tables/

# rebuild the PDF
cd docs/analysis/v2
pandoc ANALYSIS.md -o ANALYSIS.pdf --pdf-engine=tectonic \
       -V geometry:margin=0.8in -V colorlinks=true -V linkcolor=blue \
       -V mainfont="STIX Two Text" -V monofont="Menlo"
```

## Key statistical tests at a glance

| Question | Test | Result |
|---|---|---|
| Do systems differ on the same questions? | Friedman | All 9 (model × tier) reject H₀ at p ≪ 0.001 |
| Same, binary (strict + lenient cutoffs)? | Cochran's Q | All 18 (9 × 2 cutoffs) reject H₀ at p ≪ 0.001 |
| Which pairs of systems differ? | Pairwise Wilcoxon, Bonferroni-adjusted | See `tables/3_pairwise_wilcoxon.csv` |
| Same, binary? | Pairwise McNemar, Bonferroni-adjusted | See `tables/3c_mcnemar_pairs.csv` |
| Does accuracy degrade with cohort size? | Linear regression on log₁₀(tier) | No paradigm shows |slope| > 0.05 |
| Do models differ on the same questions? | Friedman across models | All combos reject H₀ at p ≪ 0.001 |

## Schema of `tables/long_format.csv`

| Column | Type | Description |
|---|---|---|
| `model` | str | claude-haiku-4-5 / qwen-2.5-72b / llama-3.1-8b |
| `tier` | int | 200 / 2000 / 20000 patient-cohort size |
| `system` | str | graph / sql-fts / sql-t2s / llm-only / graph-cypher |
| `qid` | str | Question identifier (e.g. SL-19, COH-14) |
| `type` | str | simple-lookup / cohort / temporal / multi-hop / reasoning / unanswerable |
| `judge` | float | 0.0, 0.5, or 1.0 — primary outcome |
| `fuzzy` | float | Original token-overlap score; secondary outcome |
| `latency_ms` | float | End-to-end latency for the system's answer |
| `cost_usd` | float | API cost (Claude only; OpenRouter omits) |
| `turns` | int | Number of LLM↔tool turns |
| `gt_suspect` | bool | Judge flagged the ground-truth as suspect |
| `over_answered` | bool | Correct facts present amid significant unrelated content |
