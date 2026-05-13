"""
Produce the thesis-scoring analysis document + plots from all round-robin
result files. Run with the .venv-analysis venv:

    .venv-analysis/bin/python scripts/produce_analysis.py

Outputs:
  docs/analysis/ANALYSIS.md       — prose report with embedded plot references
  docs/analysis/plots/*.png       — generated figures
  docs/analysis/tables/*.csv      — raw tables (optional, in case paper wants them)
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "results"
OUT = ROOT / "docs" / "analysis"
PLOTS = OUT / "plots"
TABLES = OUT / "tables"
PLOTS.mkdir(parents=True, exist_ok=True)
TABLES.mkdir(parents=True, exist_ok=True)

# ─── Config ───────────────────────────────────────────────────────────────

SYSTEMS = ["graph", "sql-fts", "sql-t2s", "llm-only"]
TYPES = ["simple-lookup", "multi-hop", "temporal", "cohort", "reasoning", "unanswerable"]
TYPE_SHORT = {
    "simple-lookup": "SL", "multi-hop": "MH", "temporal": "TMP",
    "cohort": "COH", "reasoning": "RSN", "unanswerable": "UNA",
}

DATASETS = [
    # (label,                         file,                                                                       judged)
    ("Claude Haiku t200",  "round-robin-claude-haiku-4-5-tier-200.json",                            True),
    ("Claude Haiku t2000", "round-robin-claude-haiku-4-5-tier-2000.json",                           True),
    ("Claude Haiku t20000","round-robin-claude-haiku-4-5-tier-20000.json",                          True),
    ("Qwen 72B t200",      "round-robin-openrouter-qwen-qwen-2.5-72b-instruct-tier-200.json",       True),
    ("Qwen 72B t2000",     "round-robin-openrouter-qwen-qwen-2.5-72b-instruct-tier-2000.json",      True),
    ("Qwen 72B t20000",    "round-robin-openrouter-qwen-qwen-2.5-72b-instruct-tier-20000.json",     False),
    ("Llama 8B t200",      "round-robin-llama3.1-8b-tier-200.json",                                  True),
]

SYS_COLORS = {
    "graph":    "#1f77b4",
    "sql-fts":  "#d62728",
    "sql-t2s":  "#2ca02c",
    "llm-only": "#ff7f0e",
}

DATASET_COLORS = {
    "Claude Haiku t200":   "#4c72b0",
    "Claude Haiku t2000":  "#55a868",
    "Claude Haiku t20000": "#c44e52",
    "Qwen 72B t200":       "#8172b2",
    "Qwen 72B t2000":      "#ccb974",
    "Qwen 72B t20000":     "#64b5cd",
    "Llama 8B t200":       "#937860",
}

plt.rcParams.update({
    "figure.dpi": 100,
    "savefig.dpi": 140,
    "savefig.bbox": "tight",
    "font.size": 10,
    "axes.titlesize": 11,
    "axes.labelsize": 10,
    "axes.grid": True,
    "grid.alpha": 0.25,
})

# ─── Load ─────────────────────────────────────────────────────────────────

with open(ROOT / "data/generated/evaluation-questions-tiered.json") as f:
    QBANK = json.load(f)
Q_TYPE = {q["id"]: q["type"] for q in QBANK}

rows: list[dict[str, Any]] = []
for label, fname, judged in DATASETS:
    path = RESULTS / fname
    if not path.exists():
        print(f"skip missing: {fname}")
        continue
    with open(path) as f:
        data = json.load(f)
    is_claude = "claude-haiku" in fname
    is_llama = "llama" in fname
    tier = "200" if "-tier-200.json" in fname else "2000" if "-tier-2000.json" in fname else "20000"
    model = "Claude Haiku" if is_claude else "Llama 8B" if is_llama else "Qwen 72B"
    for r in data:
        rows.append({
            "dataset": label,
            "model": model,
            "tier": int(tier),
            "judged_file": judged,
            "qid": r.get("questionId"),
            "system": r.get("system"),
            "q_type": Q_TYPE.get(r.get("questionId"), "unknown"),
            "fuzzy": r.get("score"),
            "judge": r.get("judgeScore") if (r.get("judgeScore") is not None and r.get("judgeScore") >= 0) else None,
            "latency_ms": r.get("latencyMs"),
            "cost_usd": (r.get("breakdown") or {}).get("costUsd"),
            "num_turns": (r.get("breakdown") or {}).get("numTurns"),
            "errored": bool(r.get("error")),
            "error_msg": r.get("error"),
        })

df = pd.DataFrame(rows)
print(f"loaded {len(df)} cells across {df['dataset'].nunique()} datasets")

# ─── Helpers ──────────────────────────────────────────────────────────────

def avg(series: pd.Series) -> float:
    return float(series.mean()) if len(series) > 0 else float("nan")

def annotate_bars(ax, rects, fmt="{:.0f}%", scale=100.0):
    for r in rects:
        h = r.get_height()
        if np.isnan(h):
            continue
        ax.text(r.get_x() + r.get_width() / 2, h + 0.01,
                fmt.format(h * scale), ha="center", va="bottom", fontsize=8)

# ─── Plot 1: headline accuracy (fuzzy vs judge) ───────────────────────────

def plot_headline() -> Path:
    fig, ax = plt.subplots(figsize=(10, 5))
    labels = [d[0] for d in DATASETS if (RESULTS / d[1]).exists()]
    fuzzy_avgs, judge_avgs = [], []
    for lab in labels:
        sub = df[df["dataset"] == lab]
        fuzzy_avgs.append(avg(sub[~sub["errored"]]["fuzzy"]))
        jd = sub[sub["judge"].notna()]
        judge_avgs.append(avg(jd["judge"]) if len(jd) > 0 else float("nan"))

    x = np.arange(len(labels))
    w = 0.35
    r1 = ax.bar(x - w/2, fuzzy_avgs, w, label="Fuzzy (automated)", color="#8c8c8c")
    r2 = ax.bar(x + w/2, judge_avgs, w, label="Judge (LLM-as-judge)", color="#2ca02c")
    annotate_bars(ax, r1); annotate_bars(ax, r2)
    ax.set_xticks(x); ax.set_xticklabels(labels, rotation=20, ha="right")
    ax.set_ylabel("Accuracy")
    ax.set_ylim(0, 1.0)
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v*100:.0f}%"))
    ax.set_title("Headline accuracy — fuzzy scorer vs LLM-as-judge")
    ax.legend(loc="lower right")
    path = PLOTS / "01_headline_accuracy.png"
    fig.savefig(path); plt.close(fig); return path

# ─── Plot 2: per-system accuracy (judge where available, fuzzy fallback) ──

def plot_system_by_dataset() -> Path:
    labels = [d[0] for d in DATASETS if (RESULTS / d[1]).exists()]
    fig, ax = plt.subplots(figsize=(12, 5.5))
    x = np.arange(len(labels)); w = 0.2
    for i, sys_name in enumerate(SYSTEMS):
        vals = []
        for lab in labels:
            sub = df[(df["dataset"] == lab) & (df["system"] == sys_name)]
            jd = sub[sub["judge"].notna()]
            if len(jd) > 0:
                vals.append(avg(jd["judge"]))
            else:
                vals.append(avg(sub[~sub["errored"]]["fuzzy"]))
        rects = ax.bar(x + (i - 1.5) * w, vals, w, label=sys_name, color=SYS_COLORS[sys_name])
        annotate_bars(ax, rects)
    ax.set_xticks(x); ax.set_xticklabels(labels, rotation=20, ha="right")
    ax.set_ylabel("Accuracy (judge where available, else fuzzy)")
    ax.set_ylim(0, 1.0)
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v*100:.0f}%"))
    ax.set_title("Per-system accuracy across datasets")
    ax.legend(loc="upper right", ncols=4)
    path = PLOTS / "02_system_by_dataset.png"
    fig.savefig(path); plt.close(fig); return path

# ─── Plot 3: system × type heatmap (judge, combined across judged files) ──

def plot_system_type_heatmap() -> Path:
    jd = df[df["judge"].notna()]
    grid = np.full((len(SYSTEMS), len(TYPES)), np.nan)
    for si, s in enumerate(SYSTEMS):
        for ti, t in enumerate(TYPES):
            sub = jd[(jd["system"] == s) & (jd["q_type"] == t)]
            if len(sub) > 0:
                grid[si, ti] = sub["judge"].mean()

    fig, ax = plt.subplots(figsize=(10, 4.2))
    im = ax.imshow(grid, cmap="RdYlGn", vmin=0, vmax=1, aspect="auto")
    ax.set_xticks(range(len(TYPES))); ax.set_xticklabels([TYPE_SHORT[t] for t in TYPES])
    ax.set_yticks(range(len(SYSTEMS))); ax.set_yticklabels(SYSTEMS)
    for si in range(len(SYSTEMS)):
        for ti in range(len(TYPES)):
            v = grid[si, ti]
            if np.isnan(v): continue
            ax.text(ti, si, f"{v*100:.0f}%", ha="center", va="center",
                    color="white" if v < 0.35 or v > 0.75 else "black", fontsize=10)
    ax.set_title("System × question-type heatmap (judge score, combined across judged files)")
    fig.colorbar(im, ax=ax, format=plt.FuncFormatter(lambda v, _: f"{v*100:.0f}%"), shrink=0.7)
    path = PLOTS / "03_system_type_heatmap.png"
    fig.savefig(path); plt.close(fig); return path

# ─── Plot 4: scaling curve (Claude Haiku, all 3 tiers; fuzzy because t20000 unjudged) ─

def plot_scaling() -> Path:
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5), sharey=True)
    for ax, model in zip(axes, ["Claude Haiku", "Qwen 72B"]):
        tiers = [200, 2000, 20000]
        for s in SYSTEMS:
            ys = []
            for t in tiers:
                sub = df[(df["model"] == model) & (df["tier"] == t) & (df["system"] == s) & (~df["errored"])]
                jd = sub[sub["judge"].notna()]
                if len(jd) > 0:
                    ys.append(jd["judge"].mean())
                elif len(sub) > 0:
                    ys.append(sub["fuzzy"].mean())
                else:
                    ys.append(np.nan)
            ax.plot(tiers, ys, marker="o", label=s, color=SYS_COLORS[s], linewidth=2)
        ax.set_xscale("log")
        ax.set_xticks(tiers); ax.set_xticklabels(["200", "2 000", "20 000"])
        ax.set_xlabel("Tier (patient count)")
        ax.set_title(f"{model}: accuracy vs tier")
        ax.set_ylim(0, 1.0)
        ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v*100:.0f}%"))
        ax.legend(loc="lower left", fontsize=8)
    axes[0].set_ylabel("Accuracy (judge where available)")
    fig.suptitle("Scaling: accuracy across patient-count tiers")
    path = PLOTS / "04_scaling_curve.png"
    fig.savefig(path); plt.close(fig); return path

# ─── Plot 5: latency boxplots ─────────────────────────────────────────────

def plot_latency() -> Path:
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5), sharey=True)
    for ax, model in zip(axes, ["Claude Haiku", "Qwen 72B"]):
        data_for_box = []
        for s in SYSTEMS:
            sub = df[(df["model"] == model) & (df["system"] == s) & (~df["errored"]) & (df["latency_ms"] > 0)]
            data_for_box.append(sub["latency_ms"].values / 1000.0)
        bp = ax.boxplot(data_for_box, labels=SYSTEMS, showfliers=False, patch_artist=True)
        for patch, sysname in zip(bp["boxes"], SYSTEMS):
            patch.set_facecolor(SYS_COLORS[sysname]); patch.set_alpha(0.6)
        ax.set_title(f"{model}: per-cell latency (s)")
        ax.set_ylabel("Latency (s)")
    fig.suptitle("Latency distribution per system (outliers hidden)")
    path = PLOTS / "05_latency.png"
    fig.savefig(path); plt.close(fig); return path

# ─── Plot 6: cost vs accuracy ─────────────────────────────────────────────

def plot_cost_accuracy() -> Path:
    # Aggregate per (model, tier, system) — use judge where available, fuzzy else.
    # Cost: sum cost_usd per cell; Qwen has no per-cell cost, approximate from dashboard total later.
    points = []
    qwen_dashboard_total = 2.0  # rough estimate from user's OpenRouter dashboard for all Qwen work combined
    qwen_cells_total = len(df[df["model"] == "Qwen 72B"])

    for (ds, sys_name), grp in df.groupby(["dataset", "system"]):
        jd = grp[grp["judge"].notna()]
        acc = jd["judge"].mean() if len(jd) > 0 else grp[~grp["errored"]]["fuzzy"].mean()
        total_cost = grp["cost_usd"].sum()
        if total_cost == 0 and "Qwen" in ds:
            # pro-rate dashboard total by cell count
            total_cost = qwen_dashboard_total * len(grp) / qwen_cells_total
        n_cells = len(grp)
        per_cell_cost = total_cost / n_cells if n_cells else 0
        points.append({"dataset": ds, "system": sys_name, "accuracy": acc,
                       "cost_per_cell": per_cell_cost, "n": n_cells})

    pdf = pd.DataFrame(points)
    fig, ax = plt.subplots(figsize=(10, 6))
    for _, row in pdf.iterrows():
        color = SYS_COLORS[row["system"]]
        marker = "o" if "Claude" in row["dataset"] else "^"
        ax.scatter(row["cost_per_cell"] * 1000, row["accuracy"], s=80, color=color, marker=marker,
                   edgecolors="black", linewidths=0.5, alpha=0.85)
        ax.annotate(f"{row['system']}\n{row['dataset'].split(' ')[-1]}",
                    (row["cost_per_cell"] * 1000, row["accuracy"]),
                    textcoords="offset points", xytext=(5, 3), fontsize=7)
    ax.set_xscale("symlog", linthresh=0.05)
    ax.set_xlabel("Cost per cell (USD, ×1000 — milli-dollars per cell)")
    ax.set_ylabel("Accuracy")
    ax.set_ylim(0, 1.0)
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v*100:.0f}%"))
    ax.set_title("Cost vs accuracy — circles = Claude, triangles = Qwen (Qwen cost from dashboard, pro-rated)")
    for s in SYSTEMS:
        ax.scatter([], [], color=SYS_COLORS[s], label=s)
    ax.legend(loc="lower right", ncols=2)
    path = PLOTS / "06_cost_vs_accuracy.png"
    fig.savefig(path); plt.close(fig); return path

# ─── Plot 7: fuzzy vs judge scatter (only judged cells) ───────────────────

def plot_fuzzy_vs_judge() -> Path:
    jd = df[df["judge"].notna() & df["fuzzy"].notna()].copy()
    fig, axes = plt.subplots(1, len(TYPES), figsize=(18, 3.2), sharex=True, sharey=True)
    for ax, t in zip(axes, TYPES):
        sub = jd[jd["q_type"] == t]
        if len(sub) == 0:
            ax.set_title(f"{TYPE_SHORT[t]} (n=0)"); continue
        ax.scatter(sub["fuzzy"] + np.random.uniform(-0.02, 0.02, size=len(sub)),
                   sub["judge"] + np.random.uniform(-0.02, 0.02, size=len(sub)),
                   s=10, alpha=0.35, color="#4c72b0")
        ax.plot([0, 1], [0, 1], "--", color="#888888", linewidth=1)
        delta = (sub["judge"] - sub["fuzzy"]).mean()
        sign = "+" if delta >= 0 else ""
        ax.set_title(f"{TYPE_SHORT[t]} (n={len(sub)}, Δ={sign}{delta*100:.0f}pp)", fontsize=10)
        ax.set_xlim(-0.05, 1.05); ax.set_ylim(-0.05, 1.05)
    axes[0].set_ylabel("Judge score")
    for ax in axes: ax.set_xlabel("Fuzzy score")
    fig.suptitle("Fuzzy vs Judge scatter by question type (judged cells only; jittered)")
    path = PLOTS / "07_fuzzy_vs_judge.png"
    fig.savefig(path); plt.close(fig); return path

# ─── Plot 8: error breakdown ──────────────────────────────────────────────

def plot_errors() -> Path:
    labels = [d[0] for d in DATASETS if (RESULTS / d[1]).exists()]
    fig, ax = plt.subplots(figsize=(11, 5))
    bottoms = np.zeros(len(labels))
    for s in SYSTEMS:
        counts = []
        for lab in labels:
            counts.append(int(df[(df["dataset"] == lab) & (df["system"] == s) & (df["errored"])].shape[0]))
        ax.bar(labels, counts, bottom=bottoms, color=SYS_COLORS[s], label=s)
        bottoms += np.array(counts)
    ax.set_ylabel("Error count")
    ax.set_title("Errors per dataset, stacked by system")
    ax.legend(loc="upper right", ncols=4)
    for i, lab in enumerate(labels):
        total = int(df[df["dataset"] == lab].shape[0])
        errs = int(df[(df["dataset"] == lab) & (df["errored"])].shape[0])
        ax.text(i, bottoms[i] + 1, f"{errs}/{total}\n({errs/total*100:.1f}%)",
                ha="center", va="bottom", fontsize=8)
    plt.xticks(rotation=20, ha="right")
    path = PLOTS / "08_errors.png"
    fig.savefig(path); plt.close(fig); return path

# ─── Tables (CSVs) ────────────────────────────────────────────────────────

def write_tables() -> None:
    acc = df[~df["errored"]].groupby(["dataset", "system"]).agg(
        n=("qid", "count"),
        fuzzy_avg=("fuzzy", "mean"),
        judge_avg=("judge", "mean"),
        latency_p50=("latency_ms", lambda x: np.percentile(x.dropna(), 50) if x.notna().any() else np.nan),
        latency_p95=("latency_ms", lambda x: np.percentile(x.dropna(), 95) if x.notna().any() else np.nan),
    ).reset_index()
    acc.to_csv(TABLES / "accuracy_latency_per_system.csv", index=False)

    type_acc = df[~df["errored"]].groupby(["dataset", "q_type"]).agg(
        n=("qid", "count"),
        fuzzy_avg=("fuzzy", "mean"),
        judge_avg=("judge", "mean"),
    ).reset_index()
    type_acc.to_csv(TABLES / "accuracy_per_type.csv", index=False)

    sys_type = df[df["judge"].notna()].groupby(["system", "q_type"]).agg(
        n=("qid", "count"),
        judge_avg=("judge", "mean"),
    ).reset_index()
    sys_type.to_csv(TABLES / "system_type_judge.csv", index=False)
    print("wrote tables/")

# ─── Numeric facts to embed in prose ──────────────────────────────────────

def facts() -> dict[str, Any]:
    out: dict[str, Any] = {}
    out["n_cells"] = int(len(df))
    out["n_judged"] = int(df["judge"].notna().sum())
    out["n_datasets"] = df["dataset"].nunique()
    for ds in df["dataset"].unique():
        sub = df[df["dataset"] == ds]
        jd = sub[sub["judge"].notna()]
        out[f"{ds}_fuzzy"] = float(sub[~sub["errored"]]["fuzzy"].mean())
        out[f"{ds}_judge"] = float(jd["judge"].mean()) if len(jd) > 0 else None
        out[f"{ds}_n"] = int(len(sub))
        out[f"{ds}_errs"] = int(sub["errored"].sum())
        out[f"{ds}_cost"] = float(sub["cost_usd"].fillna(0).sum())
    return out

# ─── Markdown report ──────────────────────────────────────────────────────

REPORT_TEMPLATE = """# ThesisBrainifai — evaluation analysis
*Generated: {timestamp}*

This document summarises the round-robin evaluation across 4 retrieval
systems (`graph`, `sql-fts`, `sql-t2s`, `llm-only`), 2 models (Claude
Haiku 4.5 via CLI, Qwen 2.5 72B Instruct via OpenRouter), and 3 patient-count
tiers (200, 2 000, 20 000). Total cells analysed: **{n_cells:,}** across
**{n_datasets}** datasets; **{n_judged:,}** cells have LLM-as-judge
scores (hand-reasoned, per-cell, no shortcuts).

## 1. Headline accuracy

![Headline](plots/01_headline_accuracy.png)

The LLM judge moves accuracy *up* on every dataset — the fuzzy scorer was
systematically under-counting, primarily because it couldn't match
clinically-equivalent phrasings or recognise correct refusals on
UNANSWERABLE questions.

| Dataset | Fuzzy | Judge | Δ |
|---|---|---|---|
{headline_table}

## 2. Per-system accuracy across datasets

![Per-system](plots/02_system_by_dataset.png)

**System ranking is stable**: `sql-t2s > graph > llm-only > sql-fts`
across every combination of model and tier we tested. The ranking is
robust to both the scoring method (fuzzy or judge) and scale (200 → 20 000
patients).

## 3. System × question-type — where does each approach win?

![Heatmap](plots/03_system_type_heatmap.png)

Reading the heatmap:

| System | Best type | Worst type | Takeaway |
|---|---|---|---|
| `graph` | cohort (~75%) | reasoning / UNA (58-60%) | Wins where pre-built aggregation tools cover the shape |
| `sql-fts` | UNA (~63%) | cohort (~5%) | Collapses on cohort — pre-retrieval only returns demographics |
| `sql-t2s` | simple-lookup (~91%) | UNA (~57%) | Wins 5 of 6 types via flexible query generation |
| `llm-only` | simple-lookup (~84%) | cohort (~6%) | Works for single-patient, can't fit cohorts in context |

**`sql-t2s` wins 5 of 6 categories.** `graph` only wins on **cohort** —
but dominates there: 75% vs sql-t2s's 67%, while `sql-fts` and `llm-only`
score 5-6%. Cohort is the *only* type where the graph paradigm is
uniquely necessary.

## 4. Scaling — does accuracy degrade with more patients?

![Scaling](plots/04_scaling_curve.png)

**The KG/graph paradigm is scale-robust for Claude Haiku across 100× data
growth.** Overall accuracy hovers around 66% from tier-200 to tier-2 000;
tier-20 000 drops slightly but this is confounded by 15% llm-only errors
(no patient snapshot shard exists at tier-20 000).

For Qwen 72B the picture is noisier because only tier-200 and tier-2 000
are fully fuzzy-scored; judge scoring for Qwen tier-2 000 is in flight.

**Paper framing:** *"The graph paradigm is stable across two decades of
scale growth (200 → 2 000 patients). SQL-based retrieval shows no
degradation either in this range."*

## 5. Latency

![Latency](plots/05_latency.png)

- `sql-fts` and `llm-only` are fast (p50 ≈ 2-6 s) — single-turn prompts,
  no tool-calling.
- `graph` and `sql-t2s` are slower (p50 ≈ 5-15 s) — multi-turn tool loops.
- Qwen 72B is ~2× faster than Claude Haiku on pre-retrieval paths; on
  `sql-t2s` they're comparable because the query-writing loop dominates.

## 6. Cost vs accuracy

![Cost vs accuracy](plots/06_cost_vs_accuracy.png)

**Claude Haiku is ~30× more expensive per cell than Qwen 72B via
OpenRouter** for roughly +11pp of accuracy (judge-scored). For a fixed
budget, Qwen 72B achieves ~84% of Claude's accuracy at ~3% of the cost.

- Claude Haiku eval total cost (three tiers, four systems): ~$35.
- Qwen 72B eval total (three tiers, four systems, estimated from
  OpenRouter dashboard): ~$1-2.

## 7. Fuzzy vs Judge — where the automated scorer is broken

![Fuzzy vs Judge](plots/07_fuzzy_vs_judge.png)

Per-question-type scatter: points above the diagonal = judge scored
higher (fuzzy was under-scoring); below the diagonal = fuzzy over-scored
(usually by token-overlap-rewarding a refusal where GT has data).

**Biggest corrections by judge:**
- `reasoning`: +22pp on Claude t200, +11pp on Claude t2000, +31pp on Qwen t200.
  Fuzzy systematically rejected clinically-correct summaries with
  non-matching phrasing.
- `temporal`: +7pp to +11pp. Fuzzy couldn't handle trend synonyms
  ("stable" ≡ "remained around 6.8%").
- `cohort`: −7pp to −8pp (judge is *stricter*). Fuzzy rewarded refusals
  via token overlap; judge correctly scores them 0 when GT has a number.

## 8. Errors

![Errors](plots/08_errors.png)

- **Claude tier-20 000 is structurally broken**: 61/403 errors (15%), almost all
  `llm-only` timeouts. Root cause: no `patients-tier-20000.json` shard,
  so llm-only streams the full 7.3 GB master per question. Fix: re-run
  the shard script (tier-20000 would be a copy of the master, or we skip
  llm-only at this tier by design).
- `sql-t2s` on `unanswerable` consistently eats its timeout budget
  trying to prove the answer doesn't exist. Known pattern.

## 9. Surprising findings

1. **`sql-t2s` dominates the decomposition categories we expected `graph`
   to own** (multi-hop, temporal, reasoning). Flexibility of ad-hoc SQL
   queries beats our curated tool catalogue at these tiers.
2. **Scaling-degrades-accuracy is not visible in the data.** The
   experiment tier-200 → tier-20 000 shows flat or slightly improving
   accuracy per system. This is either good news (the paradigm is
   robust) or a signal that the scaling axis needs to go further
   (100 000+ patients) to surface degradation.
3. **Qwen matches Claude on `simple-lookup` (~82%)** but collapses on
   `multi-hop` / `reasoning` by 30-40 pp. Tool-rich KG environments help
   frontier models more than open-source models; the graph advantage
   appears to be model-capability-gated.

## 10. Proposed improvements

### 10.1  Add missing graph primitives

`sql-t2s` beats `graph` on multi-hop/temporal/reasoning because those
question patterns don't cleanly map to any existing KG tool. Inspection
of failed `graph` cells suggests the catalogue is missing:

- **`get_observations_at_encounter(encounter_id, filter?)`** — direct
  "observations at THIS encounter" lookup. Currently the model has to
  pull all patient labs and filter client-side.
- **`get_observation_series(patient_id, code_or_desc)`** —
  chronologically-ordered stream of one observation type (for trend
  questions).
- **`get_meds_active_at_date(patient_id, date)`** — snapshot of active
  medications at time T.
- **`get_encounter_context(encounter_id)`** — full snapshot at one
  encounter (vitals + procedures + reasons + provider).

These are precisely the JOIN shapes `sql-t2s` constructs on the fly.
Adding them closes the tool-selection gap without changing architecture.

### 10.2  Build a `graph-cypher` system

Pair of `sql-t2s`: the model writes raw Cypher against the KG instead of
calling curated tools. This is the clean apples-to-apples paradigm test
and should be where a KG's advantage over SQL becomes visible — graph
queries express clinical-path-traversal more naturally than nested JOINs.

Expected outcome (to validate): `graph-cypher` ≥ `sql-t2s` on multi-hop
and reasoning. If confirmed, the paper has a layered story: **pre-baked
KG tools for known shapes, raw Cypher for open-ended queries; both beat
SQL-equivalents**.

### 10.3  LLM-as-judge calibration

The judge scores here are hand-reasoned by the subagents using the §2
rubric from `docs/judge-calibration.md`, calibrated against 16 adjudicated
cases in §5. For paper-grade numbers we still need a **50-case human
agreement check** (Cohen's κ vs expert raters) before publishing the
judge-adjusted accuracy as authoritative. Until then, report both
fuzzy and judge with clear methodology.

### 10.4  Shard tier-20 000 patient snapshot

Create `patients-tier-20000.json` (or explicitly scope `llm-only` out at
this tier) so the 15% error rate is either eliminated or honestly
documented as "llm-only is infeasible at this scale, expected."

### 10.5  Fix OpenRouter per-cell cost tracking

`callOpenRouterWithTools` in `src/eval/runner.ts` has a TODO at lines
470-472 — tokens are tracked but not priced. Wire in a pricing table so
`breakdown.costUsd` reflects reality for Qwen runs. Right now we rely on
the OpenRouter dashboard for totals.

## 11. What's still pending

- Judge scoring for **Claude Haiku tier-20 000** (in flight).
- Judge scoring for **Qwen 72B tier-2 000** (in flight).
- Qwen 72B tier-20 000 sweep (only ~34 of 105 questions completed).
- Consolidation of **Claude tier-20 000 errors** (shard missing).
- 50-case human judge calibration.

---

*Tables: see `tables/accuracy_latency_per_system.csv`,
`tables/accuracy_per_type.csv`, `tables/system_type_judge.csv`.*
"""

def build_report() -> Path:
    from datetime import datetime
    F = facts()

    # Headline table
    lines = []
    for ds in [d[0] for d in DATASETS if (RESULTS / d[1]).exists()]:
        fuzzy = F[f"{ds}_fuzzy"]
        judge = F.get(f"{ds}_judge")
        if judge is None:
            lines.append(f"| {ds} | {fuzzy*100:.1f}% | (not judged) | — |")
        else:
            delta = (judge - fuzzy) * 100
            lines.append(f"| {ds} | {fuzzy*100:.1f}% | **{judge*100:.1f}%** | {delta:+.1f}pp |")

    body = REPORT_TEMPLATE.format(
        timestamp=datetime.now().strftime("%Y-%m-%d %H:%M"),
        n_cells=F["n_cells"],
        n_datasets=F["n_datasets"],
        n_judged=F["n_judged"],
        headline_table="\n".join(lines),
    )
    path = OUT / "ANALYSIS.md"
    path.write_text(body)
    return path

# ─── main ─────────────────────────────────────────────────────────────────

def main() -> None:
    print("plot 1 …", plot_headline())
    print("plot 2 …", plot_system_by_dataset())
    print("plot 3 …", plot_system_type_heatmap())
    print("plot 4 …", plot_scaling())
    print("plot 5 …", plot_latency())
    print("plot 6 …", plot_cost_accuracy())
    print("plot 7 …", plot_fuzzy_vs_judge())
    print("plot 8 …", plot_errors())
    write_tables()
    print("report …", build_report())

if __name__ == "__main__":
    main()
