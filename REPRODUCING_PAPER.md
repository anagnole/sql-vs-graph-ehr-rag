# Reproducing the paper

End-to-end walkthrough from `git clone` to the figures and tables in **"Knowledge Graphs vs. SQL Over Structured EHR Data"** (Anagnou et al., 2026).

The full pipeline produces the 13 640 judged cells, the statistical tests, and Figures 2–8 of the paper. Expect **roughly $150–$250 of OpenRouter spend** for the Qwen and Llama runs at full scale; the Claude runs are free if you have a Claude Code subscription.

---

## 0. Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | ≥ 18 | TypeScript pipeline |
| Python | ≥ 3.10 | Statistical analysis |
| Docker | any recent | PostgreSQL |
| Synthea | `brew install synthea` | Synthetic patient generation |
| Claude CLI | latest | Claude Haiku 4.5 runs + MCP transport |

Environment variables:

```bash
export OPENROUTER_API_KEY=sk-or-v1-…   # required for Qwen / Llama
export ANTHROPIC_API_KEY=sk-ant-…       # optional, Claude CLI may already be authenticated
```

Python deps:

```bash
python3 -m venv .venv-analysis
.venv-analysis/bin/pip install numpy pandas scipy seaborn matplotlib
```

---

## 1. Clone and install

```bash
git clone https://github.com/anagnole/EHR-Clinical-Assistant
cd EHR-Clinical-Assistant
npm install
npm run pg:up                # PostgreSQL 16 on :5432
```

---

## 2. Generate the synthetic cohort

The paper uses a single Synthea run with **seed 42** producing 20 000 alive patients. Smaller cohorts are strict subsets.

```bash
# Run Synthea once, then place the CSV output in data/synthea/
synthea -s 42 -p 20000 \
        --exporter.csv.export true \
        --exporter.baseDirectory ./data/synthea

# Parse the CSVs, profile, build the 334-question bank
npm run generate
```

Outputs:

- `data/generated/patients.json` — per-patient JSON snapshots
- `data/generated/evaluation-questions-tiered.json` — the 334-question bank
- `data/generated/ground-truth.json` — supporting record IDs per question
- `data/generated/stats.json` — cohort summary statistics

---

## 3. Build the three nested cohorts

```bash
npm run curate-tiers          # tier-200 ⊂ tier-2000 ⊂ tier-20000
npm run ingest                # all three tiers into Kuzu
npm run pg:ingest             # all three tiers into PostgreSQL (+ FTS variant)
npm run verify                # cross-check graph and SQL row counts
```

Verify: at tier-20000 the graph should report 11.9M observations and 657 619 conditions; PostgreSQL should match.

---

## 4. Run the evaluation grid

The full grid is **5 approaches × 3 models × 3 tiers = 45 combinations**, each against 334 questions ≈ 15 030 (question, approach, model, tier) cells.

```bash
# Example: one combination
npm run eval -- --model claude-haiku-4-5 --system sql-t2s --tier 200

# Hosted models go through OpenRouter
npm run eval -- --model qwen/qwen-2.5-72b-instruct  --system graph --tier 2000  --hosted
npm run eval -- --model meta-llama/llama-3.1-8b-instruct --system graph-cypher --tier 20000 --hosted
```

Useful flags:

- `--resume` — continue from `results/incremental-<model>.json` after an interrupted run
- `--retry-errors` — re-run only cells that hit transport errors
- `--limit N` — first N questions only (for smoke-testing)
- `--skip-type cohort` — exclude one of the six question categories

Results are stored per model in `results/incremental-<model>.json`; the 5 systems × 3 tiers within each model file are kept disjoint, so independent runs do not overwrite each other.

To sweep an entire model in one go:

```bash
.venv-analysis/bin/tsx scripts/round-robin-sweep.ts        # Claude
.venv-analysis/bin/tsx scripts/round-robin-sweep-qwen.ts   # Qwen via OpenRouter
```

---

## 5. Score answers with the LLM judge

The judge is **Claude Haiku 4.5** using the rubric in `docs/analysis/v2/judge-rubric.md`. Scoring runs as part of `npm run eval`; each cell receives a judge score `∈ {0, 0.5, 1.0}`, the `gt_suspect` and `over_answered` flags, and a one-line rationale.

To re-judge an existing results file (e.g., after a rubric update) without re-running the LLMs:

```bash
.venv-analysis/bin/tsx scripts/grade-against-data.ts --model claude-haiku-4-5
```

---

## 6. Produce the paper's figures and tables

```bash
.venv-analysis/bin/python scripts/analysis_v2.py
```

This populates `docs/analysis/v2/`:

| Output | Paper reference |
|---|---|
| `plots/0_pipeline.png` | Figure 1 — pipeline overview |
| `plots/1_system_means.png` | Figure 2 — accuracy per approach × subset |
| `plots/3_pairwise_heatmaps.png` | Figure 3 — pairwise Wilcoxon, pooled across subsets |
| `plots/5_type_system_heatmap.png` | Figure 4 — accuracy by question type |
| `plots/4_scaling_curves.png` | Figure 5 — accuracy vs. cohort size |
| `plots/12_tool_vs_llmonly_gap.png` | Figure 6 — tool-using − context-only gap |
| `plots/11_latency.png` | Figure 7 — latency distribution |
| `plots/8_flag_rates.png` | Figure 8 — judge flag rates |
| `tables/1_descriptive_means.csv` | Table 2 — best-approach per (model, subset) |
| `tables/2_friedman.csv` | Table 3 — Friedman omnibus |
| `tables/4_scaling_regression.csv` | Table 4 — log-cohort regression |

A full prose write-up of the analysis is at `docs/analysis/v2/ANALYSIS.md`.

---

## 7. Skip-the-LLM shortcut

If you just want to verify the **statistical** claims without running 45 model-grid evaluations, the `long_format.csv` shipped at `docs/analysis/v2/tables/long_format.csv` contains every judged cell. Re-running step 6 will reproduce all figures and tables from that file alone.

```bash
.venv-analysis/bin/python scripts/analysis_v2.py
```

---

## Cost and runtime estimates (full grid)

| Model | Approx. spend | Approx. wall time |
|---|---|---|
| Claude Haiku 4.5 (via Claude CLI) | $0 (subscription) | ~6 h |
| Qwen 2.5 72B (OpenRouter) | ~$80 – $120 | ~12 h |
| Llama 3.1 8B (OpenRouter) | ~$30 – $60 | ~8 h |
| LLM-as-judge (Claude Haiku 4.5) | $0 (subscription) | ~3 h |

Numbers are upper bounds; the actual cost depends on how often agentic loops hit the 20-turn budget. Llama is unusually expensive per question because it frequently exhausts the turn budget on `graph` and `graph-cypher`.

---

## Troubleshooting

- **`graph-cypher` runs hang on Qwen** — known issue; the model repeatedly emits Cypher the database rejects. Either reduce `--max-turns` (default 20) or skip `--system graph-cypher` for Qwen.
- **OpenRouter rate limits** — the sweep scripts have built-in retry with exponential backoff. If you still see 429s, lower `EVAL_CONCURRENCY` (default 4) in the env.
- **PostgreSQL FTS slow at tier-20000** — make sure `tsvector` GIN indexes were built by `npm run pg:ingest`; check with `\d+ conditions` and look for the `tsv` column + index.
- **Kuzu out-of-memory at tier-20000** — bump JVM heap via `NODE_OPTIONS="--max-old-space-size=8192"` during `npm run ingest`.

---

## Citation

```bibtex
@article{anagnou2026graphsql,
  title  = {Knowledge Graphs vs. SQL Over Structured EHR Data},
  author = {Anagnou, Leonidas and Vezakis, Andreas and Vezakis, Ioannis
           and Kakkos, Ioannis and Matsopoulos, George K.},
  journal= {Future Internet},
  year   = {2026},
  note   = {In press}
}
```
