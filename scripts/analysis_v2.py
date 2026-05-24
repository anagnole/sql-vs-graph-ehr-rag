"""
Comprehensive statistical analysis of paradigm comparison.

Loads all 10 round-robin result files, builds a long-format DataFrame, and
runs:
  1. Descriptive stats per (model, tier, system) with bootstrap 95% CIs
  2. Friedman test (repeated measures across systems on the same questions)
  3. Pairwise Wilcoxon signed-rank with Bonferroni correction
  4. Cliff's delta effect sizes
  5. Scaling regression per system across tiers
  6. Type x system means (heatmap)
  7. Fuzzy vs judge agreement (Cohen's kappa, Spearman)
  8. Cost-effectiveness frontier

Outputs:
  docs/analysis/v2/ANALYSIS.md  -- writeup with embedded plots
  docs/analysis/v2/plots/*.png
  docs/analysis/v2/tables/*.csv
"""

import json
from pathlib import Path
from itertools import combinations
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
from scipy import stats

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs/analysis/v2"
PLOTS = OUT / "plots"
TABLES = OUT / "tables"
PLOTS.mkdir(parents=True, exist_ok=True)
TABLES.mkdir(parents=True, exist_ok=True)

sns.set_theme(style="whitegrid", context="paper", font_scale=1.0)
plt.rcParams["figure.dpi"] = 110
plt.rcParams["savefig.dpi"] = 150
plt.rcParams["savefig.bbox"] = "tight"

# Local Q4-quantized Llama excluded — different deployment from the hosted
# fp16 run, so mixing them would conflate quantization with model. Hosted
# tier-200 is the apples-to-apples comparison point.
FILES = [
    ("claude-haiku-4-5", "200",   "results/round-robin-claude-haiku-4-5-tier-200.json"),
    ("claude-haiku-4-5", "2000",  "results/round-robin-claude-haiku-4-5-tier-2000.json"),
    ("claude-haiku-4-5", "20000", "results/round-robin-claude-haiku-4-5-tier-20000.json"),
    ("qwen-2.5-72b",     "200",   "results/round-robin-openrouter-qwen-qwen-2.5-72b-instruct-tier-200.json"),
    ("qwen-2.5-72b",     "2000",  "results/round-robin-openrouter-qwen-qwen-2.5-72b-instruct-tier-2000.json"),
    ("qwen-2.5-72b",     "20000", "results/round-robin-openrouter-qwen-qwen-2.5-72b-instruct-tier-20000.json"),
    ("llama-3.1-8b",     "200",   "results/round-robin-openrouter-meta-llama-llama-3.1-8b-instruct-tier-200.json"),
    ("llama-3.1-8b",     "2000",  "results/round-robin-openrouter-meta-llama-llama-3.1-8b-instruct-tier-2000.json"),
    ("llama-3.1-8b",     "20000", "results/round-robin-openrouter-meta-llama-llama-3.1-8b-instruct-tier-20000.json"),
]

SYSTEMS = ["graph", "sql-fts", "sql-t2s", "llm-only", "graph-cypher"]
SYSTEM_PALETTE = {
    "graph":         "#4C72B0",
    "sql-fts":       "#DD8452",
    "sql-t2s":       "#55A467",
    "llm-only":      "#C44E52",
    "graph-cypher":  "#8172B3",
}
MODEL_PALETTE = {
    "claude-haiku-4-5":  "#1f77b4",
    "qwen-2.5-72b":      "#2ca02c",
    "llama-3.1-8b":      "#d62728",
}
TYPE_ORDER = ["simple-lookup", "cohort", "temporal", "multi-hop", "reasoning", "unanswerable"]

# ─────────────────────────────────────────────────────────────────────────────
# Load
# ─────────────────────────────────────────────────────────────────────────────

rows = []
for model, tier, path in FILES:
    p = ROOT / path
    if not p.exists():
        print("missing:", path)
        continue
    cells = json.loads(p.read_text())
    for c in cells:
        if c.get("error"):
            continue
        if c.get("judgeScore") is None:
            continue
        rows.append({
            "model": model,
            "tier": int(tier),
            "system": c["system"],
            "qid": c["questionId"],
            "type": c.get("type"),
            "judge": float(c["judgeScore"]),
            "fuzzy": float(c.get("score", 0.0)) if c.get("score") is not None else None,
            "latency_ms": c.get("latencyMs"),
            "cost_usd": (c.get("breakdown") or {}).get("costUsd"),
            "turns":    (c.get("breakdown") or {}).get("numTurns"),
            "gt_suspect": bool(c.get("judge_gt_suspect", False)),
            "over_answered": bool(c.get("judge_over_answered", False)),
        })

df = pd.DataFrame(rows)


# ─────────────────────────────────────────────────────────────────────────────
# Pipeline diagram for §1 (question → 5 systems in parallel → judge → score)
# ─────────────────────────────────────────────────────────────────────────────
def draw_pipeline_diagram(path):
    fig, ax = plt.subplots(figsize=(11, 5))
    ax.set_xlim(0, 10); ax.set_ylim(0, 6); ax.axis("off")
    from matplotlib.patches import FancyBboxPatch
    def box(x, y, w, h, text, color="#dde6f0"):
        ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.05",
                                    fc=color, ec="black", lw=1.0))
        ax.text(x + w/2, y + h/2, text, ha="center", va="center", fontsize=9)
    def arrow(x1, y1, x2, y2):
        ax.annotate("", xy=(x2, y2), xytext=(x1, y1),
                    arrowprops=dict(arrowstyle="->", lw=1.2, color="#333"))
    # Question
    box(0.2, 2.5, 1.6, 1.0, "Question\n(334 in bank)", color="#fff2cc")
    # 5 systems in parallel
    systems_text = [
        ("graph\n(curated MCP tools)", "#cfe2f3"),
        ("sql-fts\n(text search)", "#fce5cd"),
        ("sql-t2s\n(text→SQL)", "#d9ead3"),
        ("llm-only\n(snapshot in ctx)", "#f4cccc"),
        ("graph-cypher\n(text→Cypher)", "#d9d2e9"),
    ]
    for i, (txt, c) in enumerate(systems_text):
        box(2.5, 5 - i*1.0, 2.2, 0.8, txt, color=c)
        arrow(1.85, 3.0, 2.45, 5.4 - i*1.0)
        arrow(4.75, 5.4 - i*1.0, 5.35, 3.0)
    # Judge
    box(5.4, 2.5, 1.9, 1.0, "Judge\n(LLM as judge,\n0 / 0.5 / 1)", color="#ead1dc")
    arrow(7.35, 3.0, 7.95, 3.0)
    # Scored cell
    box(8.0, 2.5, 1.8, 1.0, "Scored cell\n(judgeScore +\nrationale)", color="#fff2cc")
    # Labels
    ax.text(3.6, 5.95, "5 retrieval approaches (run in parallel per question)",
            ha="center", fontsize=10, style="italic")
    ax.text(5.0, 0.4,
            f"Repeated for: 3 models (Claude/Qwen/Llama) × 3 tiers (200/2K/20K) × {len(df):,} judged cells",
            ha="center", fontsize=9, color="#444")
    plt.savefig(path)
    plt.close()
draw_pipeline_diagram(PLOTS / "0_pipeline.png")

# `type` is only populated on some cells (graph-cypher path sets it; others
# saved it inconsistently). Backfill from the question bank by qid so every
# cell has a type.
qbank_path = ROOT / "data/generated/evaluation-questions-tiered.json"
if qbank_path.exists():
    qbank = json.loads(qbank_path.read_text())
    qid_to_type = {q["id"]: q["type"] for q in qbank}
    df["type"] = df.apply(lambda r: r["type"] if pd.notna(r["type"]) else qid_to_type.get(r["qid"]), axis=1)

print("loaded", len(df), "judged cells")
print(df.groupby(["model", "tier"]).size().unstack(fill_value=0))

df.to_csv(TABLES / "long_format.csv", index=False)


def boot_ci(x, n=2000, alpha=0.05, seed=42):
    """Bootstrap percentile CI for the mean."""
    x = np.asarray(x, dtype=float)
    if len(x) == 0:
        return (np.nan, np.nan, np.nan)
    rng = np.random.default_rng(seed)
    boots = rng.choice(x, size=(n, len(x)), replace=True).mean(axis=1)
    lo, hi = np.quantile(boots, [alpha / 2, 1 - alpha / 2])
    return (float(x.mean()), float(lo), float(hi))


# ─────────────────────────────────────────────────────────────────────────────
# 1. Descriptive: system means per (model, tier) with 95% CI
# ─────────────────────────────────────────────────────────────────────────────

desc = []
for (model, tier, system), g in df.groupby(["model", "tier", "system"]):
    m, lo, hi = boot_ci(g["judge"].values)
    desc.append({
        "model": model, "tier": tier, "system": system, "n": len(g),
        "mean": m, "ci_lo": lo, "ci_hi": hi,
    })
desc_df = pd.DataFrame(desc).sort_values(["model", "tier", "system"])
desc_df.to_csv(TABLES / "1_descriptive_means.csv", index=False)

# Plot: faceted bar by model, x=tier, hue=approach
g = sns.catplot(
    data=desc_df.rename(columns={"system": "approach"}),
    x="tier", y="mean", hue="approach", col="model",
    kind="bar", height=4, aspect=1.0, palette=SYSTEM_PALETTE,
    hue_order=SYSTEMS,
)
for ax, (model_name, sub) in zip(g.axes.flat, desc_df.groupby("model")):
    for i, system in enumerate(SYSTEMS):
        rows_s = sub[sub["system"] == system]
        # bar positions: tier on x, hue offset
        n_tiers = sub["tier"].nunique()
        # Let seaborn handle bars; we just add error bars manually
    # Add error bars manually
    for tier_i, tier in enumerate(sorted(sub["tier"].unique())):
        for sys_i, system in enumerate(SYSTEMS):
            r = sub[(sub["tier"] == tier) & (sub["system"] == system)]
            if r.empty:
                continue
            n_sys = len(SYSTEMS)
            width = 0.8 / n_sys
            x_center = tier_i - 0.4 + width * (sys_i + 0.5)
            ax.errorbar(
                x_center, r["mean"].iloc[0],
                yerr=[[r["mean"].iloc[0] - r["ci_lo"].iloc[0]], [r["ci_hi"].iloc[0] - r["mean"].iloc[0]]],
                fmt="none", ecolor="black", capsize=2, alpha=0.7,
            )
    ax.set_ylim(0, 1.0)
    ax.set_ylabel("Judge score")
    ax.set_xlabel("subset")
g.set_titles("{col_name}")
g.fig.suptitle("Judge accuracy per approach × subset (95% bootstrap CI)", y=1.02)
plt.savefig(PLOTS / "1_system_means.png", dpi=150, bbox_inches="tight")
plt.close()


# ─────────────────────────────────────────────────────────────────────────────
# 2. Friedman test per (model, tier): are systems different on same questions?
# ─────────────────────────────────────────────────────────────────────────────

friedman = []
for (model, tier), g in df.groupby(["model", "tier"]):
    # Pivot: rows=qid, cols=system. Drop questions where any system missing.
    pv = g.pivot_table(index="qid", columns="system", values="judge", aggfunc="mean")
    pv = pv.dropna()
    if pv.shape[0] < 5 or pv.shape[1] < 3:
        continue
    stat, p = stats.friedmanchisquare(*[pv[c].values for c in pv.columns])
    friedman.append({
        "model": model, "tier": tier, "n_questions": pv.shape[0],
        "n_systems": pv.shape[1], "chi2": stat, "p": p,
    })
fried_df = pd.DataFrame(friedman)
fried_df.to_csv(TABLES / "2_friedman.csv", index=False)


# ─────────────────────────────────────────────────────────────────────────────
# 3. Pairwise Wilcoxon (paired) with Bonferroni
# ─────────────────────────────────────────────────────────────────────────────

def cliffs_delta(a, b):
    """Cliff's delta non-parametric effect size in [-1, 1]."""
    a = np.asarray(a); b = np.asarray(b)
    n_a, n_b = len(a), len(b)
    if n_a == 0 or n_b == 0:
        return np.nan
    gt = np.sum(a[:, None] > b[None, :])
    lt = np.sum(a[:, None] < b[None, :])
    return (gt - lt) / (n_a * n_b)


pairs = []
for (model, tier), g in df.groupby(["model", "tier"]):
    pv = g.pivot_table(index="qid", columns="system", values="judge", aggfunc="mean").dropna()
    if pv.shape[0] < 5:
        continue
    sys_present = list(pv.columns)
    n_pairs = len(list(combinations(sys_present, 2)))
    bonf = max(1, n_pairs)
    for s1, s2 in combinations(sys_present, 2):
        a, b = pv[s1].values, pv[s2].values
        # Wilcoxon needs non-zero differences; use 'pratt' for ties
        try:
            stat, p = stats.wilcoxon(a, b, zero_method="pratt", alternative="two-sided")
        except ValueError:
            stat, p = np.nan, 1.0
        pairs.append({
            "model": model, "tier": tier,
            "sys_a": s1, "sys_b": s2,
            "mean_a": float(a.mean()), "mean_b": float(b.mean()),
            "diff": float(a.mean() - b.mean()),
            "n": len(a), "wilcoxon": stat, "p": p,
            "p_bonf": min(1.0, p * bonf),
            "cliff_delta": cliffs_delta(a, b),
        })
pairs_df = pd.DataFrame(pairs)
pairs_df.to_csv(TABLES / "3_pairwise_wilcoxon.csv", index=False)

# Significance heatmap per (model, tier)
def plot_sig_heatmap(model, tier, sub, ax):
    sys_list = sorted(set(sub["sys_a"]).union(sub["sys_b"]))
    M = pd.DataFrame(np.nan, index=sys_list, columns=sys_list)
    for _, r in sub.iterrows():
        # Cell shows mean(row) - mean(col). Stars from p_bonf.
        M.loc[r["sys_a"], r["sys_b"]] = r["diff"]
        M.loc[r["sys_b"], r["sys_a"]] = -r["diff"]
    annot = M.copy().astype(object)
    for _, r in sub.iterrows():
        diff = r["diff"]
        sig = "***" if r["p_bonf"] < 0.001 else "**" if r["p_bonf"] < 0.01 else "*" if r["p_bonf"] < 0.05 else ""
        s = f"{diff:+.2f}{sig}"
        annot.loc[r["sys_a"], r["sys_b"]] = s
        annot.loc[r["sys_b"], r["sys_a"]] = f"{-diff:+.2f}{sig}"
    for s in sys_list:
        annot.loc[s, s] = "—"
    sns.heatmap(M.astype(float), annot=annot.values, fmt="", cmap="RdBu_r", center=0,
                vmin=-0.4, vmax=0.4, cbar_kws={"label": "row − col"}, ax=ax,
                linewidths=0.5, linecolor="white")
    ax.set_title(f"{model} / tier-{tier}")


unique_combos = pairs_df[["model","tier"]].drop_duplicates().sort_values(["model","tier"])
n_combos = len(unique_combos)
ncols = 3
nrows = int(np.ceil(n_combos / ncols))
fig, axes = plt.subplots(nrows, ncols, figsize=(ncols*5, nrows*4))
axes = np.atleast_2d(axes).flatten()
for ax_i, (_, r) in enumerate(unique_combos.iterrows()):
    sub = pairs_df[(pairs_df["model"] == r["model"]) & (pairs_df["tier"] == r["tier"])]
    plot_sig_heatmap(r["model"], r["tier"], sub, axes[ax_i])
for j in range(ax_i + 1, len(axes)):
    axes[j].axis("off")
fig.suptitle("Pairwise system differences (judge), Bonferroni-adjusted: *p<.05, **p<.01, ***p<.001", y=1.02)
plt.savefig(PLOTS / "3_pairwise_heatmaps.png")
plt.close()


# ─────────────────────────────────────────────────────────────────────────────
# 3b. Cochran's Q (binary outcome, k matched groups)
# 3c. McNemar pairwise (binary outcome, paired)
#
# Binary-data analogs of Friedman (3) and Wilcoxon (3a). Two cutoffs:
#   - "strict":  judge == 1.0   (only fully-correct counts)
#   - "lenient": judge >= 0.5   (correct + partial counts)
# ─────────────────────────────────────────────────────────────────────────────

from statsmodels.stats.contingency_tables import mcnemar, cochrans_q

CUTOFFS = [("strict", lambda x: (x == 1.0).astype(int)),
           ("lenient", lambda x: (x >= 0.5).astype(int))]

cochran_rows = []
mcnemar_rows = []
for cutoff_name, fn in CUTOFFS:
    for (model, tier), g in df.groupby(["model", "tier"]):
        pv = g.pivot_table(index="qid", columns="system", values="judge", aggfunc="mean").dropna()
        if pv.shape[0] < 5 or pv.shape[1] < 2:
            continue
        bin_pv = pv.apply(fn)
        # Cochran's Q across all systems present
        try:
            res = cochrans_q(bin_pv.values)
            q_stat, q_p, q_df = res.statistic, res.pvalue, res.df
        except Exception:
            q_stat = np.nan; q_p = np.nan; q_df = np.nan
        sys_present = list(bin_pv.columns)
        cochran_rows.append({
            "cutoff": cutoff_name, "model": model, "tier": tier,
            "n_questions": bin_pv.shape[0], "n_systems": len(sys_present),
            "Q": q_stat, "df": q_df, "p": q_p,
            **{f"pct_correct[{s}]": float(bin_pv[s].mean()) for s in sys_present},
        })
        # McNemar for each pair, Bonferroni across pairs
        pair_list = list(combinations(sys_present, 2))
        bonf = max(1, len(pair_list))
        for s1, s2 in pair_list:
            a = bin_pv[s1].values
            b = bin_pv[s2].values
            tab = np.array([[((a == 1) & (b == 1)).sum(), ((a == 1) & (b == 0)).sum()],
                            [((a == 0) & (b == 1)).sum(), ((a == 0) & (b == 0)).sum()]])
            b_count = int(tab[0, 1]); c_count = int(tab[1, 0])
            try:
                m = mcnemar(tab, exact=(b_count + c_count < 25), correction=True)
                m_stat = float(m.statistic); m_p = float(m.pvalue)
            except Exception:
                m_stat = np.nan; m_p = np.nan
            mcnemar_rows.append({
                "cutoff": cutoff_name, "model": model, "tier": tier,
                "sys_a": s1, "sys_b": s2,
                "n_questions": len(a),
                "a_only_right": b_count, "b_only_right": c_count,
                "both_right": int(tab[0, 0]), "both_wrong": int(tab[1, 1]),
                "diff_pct": float(a.mean() - b.mean()),
                "statistic": m_stat, "p": m_p, "p_bonf": min(1.0, m_p * bonf) if not np.isnan(m_p) else np.nan,
            })

cochran_df = pd.DataFrame(cochran_rows)
mcnemar_df = pd.DataFrame(mcnemar_rows)
cochran_df.to_csv(TABLES / "3b_cochran_q.csv", index=False)
mcnemar_df.to_csv(TABLES / "3c_mcnemar_pairs.csv", index=False)


def plot_mcnemar_heatmaps(cutoff_name, mcnemar_df, out_path):
    sub_all = mcnemar_df[mcnemar_df["cutoff"] == cutoff_name]
    combos = sub_all[["model", "tier"]].drop_duplicates().sort_values(["model", "tier"])
    ncols = 3
    nrows = int(np.ceil(len(combos) / ncols))
    fig, axes = plt.subplots(nrows, ncols, figsize=(ncols*5, nrows*4))
    axes = np.atleast_2d(axes).flatten()
    for ax_i, (_, r) in enumerate(combos.iterrows()):
        sub = sub_all[(sub_all["model"] == r["model"]) & (sub_all["tier"] == r["tier"])]
        if sub.empty: continue
        sys_list = sorted(set(sub["sys_a"]).union(sub["sys_b"]))
        M = pd.DataFrame(np.nan, index=sys_list, columns=sys_list)
        annot = pd.DataFrame("", index=sys_list, columns=sys_list, dtype=object)
        for _, rr in sub.iterrows():
            d = rr["diff_pct"]
            sig = "***" if rr["p_bonf"] < 0.001 else "**" if rr["p_bonf"] < 0.01 else "*" if rr["p_bonf"] < 0.05 else ""
            M.loc[rr["sys_a"], rr["sys_b"]] = d
            M.loc[rr["sys_b"], rr["sys_a"]] = -d
            annot.loc[rr["sys_a"], rr["sys_b"]] = f"{d:+.2f}{sig}"
            annot.loc[rr["sys_b"], rr["sys_a"]] = f"{-d:+.2f}{sig}"
        for s in sys_list:
            annot.loc[s, s] = "—"
        sns.heatmap(M.astype(float), annot=annot.values, fmt="", cmap="RdBu_r", center=0,
                    vmin=-0.5, vmax=0.5, cbar_kws={"label": "row − col (Δ proportion correct)"},
                    ax=axes[ax_i], linewidths=0.5, linecolor="white")
        axes[ax_i].set_title(f"{r['model']} / tier-{r['tier']}")
    for j in range(len(combos), len(axes)):
        axes[j].axis("off")
    fig.suptitle(f"McNemar pairwise diffs ({cutoff_name} cutoff), Bonferroni-adjusted: *p<.05, **p<.01, ***p<.001", y=1.02)
    plt.savefig(out_path)
    plt.close()


plot_mcnemar_heatmaps("strict",  mcnemar_df, PLOTS / "3b_mcnemar_strict.png")
plot_mcnemar_heatmaps("lenient", mcnemar_df, PLOTS / "3c_mcnemar_lenient.png")


# ─────────────────────────────────────────────────────────────────────────────
# 4. Scaling regression: judge ~ tier per (model, system)
# ─────────────────────────────────────────────────────────────────────────────

scaling = []
for (model, system), g in df[df["model"].isin(["claude-haiku-4-5", "qwen-2.5-72b", "llama-3.1-8b"])].groupby(["model", "system"]):
    if g["tier"].nunique() < 2:
        continue
    # Per-question per-tier: just use raw cells. Regression of judge on log10(tier).
    x = np.log10(g["tier"].values.astype(float))
    y = g["judge"].values.astype(float)
    if len(x) < 10:
        continue
    slope, intercept, r, p, se = stats.linregress(x, y)
    # 95% CI on slope
    n = len(x)
    t_crit = stats.t.ppf(0.975, n - 2)
    scaling.append({
        "model": model, "system": system,
        "slope_per_log10_tier": slope, "ci_lo": slope - t_crit * se, "ci_hi": slope + t_crit * se,
        "intercept": intercept, "r": r, "p": p, "n": n,
    })
scaling_df = pd.DataFrame(scaling).sort_values(["model", "system"])
scaling_df.to_csv(TABLES / "4_scaling_regression.csv", index=False)

# Plot scaling curves: per-model, x=tier (log), y=mean judge with 95% CI per system
fig, axes = plt.subplots(1, 3, figsize=(15, 4.5), sharey=True)
for ax, model in zip(axes, ["claude-haiku-4-5", "qwen-2.5-72b", "llama-3.1-8b"]):
    sub = desc_df[desc_df["model"] == model]
    for system in SYSTEMS:
        s = sub[sub["system"] == system].sort_values("tier")
        if s.empty:
            continue
        ax.errorbar(
            s["tier"], s["mean"],
            yerr=[s["mean"] - s["ci_lo"], s["ci_hi"] - s["mean"]],
            label=system, marker="o", color=SYSTEM_PALETTE[system], capsize=3,
        )
    ax.set_xscale("log")
    ax.set_xticks([200, 2000, 20000])
    ax.set_xticklabels(["200", "2K", "20K"])
    ax.set_xlabel("Cohort size (patients, log)")
    ax.set_title(model)
    ax.set_ylim(0, 1)
    ax.grid(True, alpha=0.3)
axes[0].set_ylabel("Judge score")
axes[-1].legend(loc="center left", bbox_to_anchor=(1.02, 0.5))
fig.suptitle("Scaling: judge accuracy across cohort sizes (95% CI)", y=1.02)
plt.savefig(PLOTS / "4_scaling_curves.png")
plt.close()


# ─────────────────────────────────────────────────────────────────────────────
# 5. Type × system heatmap (per model, all tiers pooled)
# ─────────────────────────────────────────────────────────────────────────────

fig, axes = plt.subplots(1, 3, figsize=(18, 5))
models_to_plot = ["claude-haiku-4-5", "qwen-2.5-72b", "llama-3.1-8b"]
for ax, model in zip(axes, models_to_plot):
    sub = df[df["model"] == model]
    if sub.empty:
        continue
    pivot = sub.pivot_table(index="type", columns="system", values="judge", aggfunc="mean")
    pivot = pivot.reindex(index=[t for t in TYPE_ORDER if t in pivot.index],
                           columns=[s for s in SYSTEMS if s in pivot.columns])
    sns.heatmap(pivot, annot=True, fmt=".2f", cmap="RdYlGn", vmin=0, vmax=1,
                cbar_kws={"label": "Judge score"}, ax=ax, linewidths=0.5)
    ax.set_title(model)
fig.suptitle("Question type × system mean accuracy (judge)", y=1.02)
plt.savefig(PLOTS / "5_type_system_heatmap.png")
plt.close()

# Save table too
type_sys = df.groupby(["model", "type", "system"])["judge"].mean().reset_index()
type_sys.to_csv(TABLES / "5_type_system_means.csv", index=False)


# ─────────────────────────────────────────────────────────────────────────────
# 6. Fuzzy vs judge agreement
# ─────────────────────────────────────────────────────────────────────────────

ag = df.dropna(subset=["fuzzy"]).copy()
# Bin fuzzy to {0, 0.5, 1} for kappa: <0.4 -> 0, 0.4-0.7 -> 0.5, >=0.7 -> 1 (rough mapping)
def bin_fuzzy(x):
    if x < 0.4: return 0.0
    if x < 0.7: return 0.5
    return 1.0
ag["fuzzy_bin"] = ag["fuzzy"].apply(bin_fuzzy)

from sklearn.metrics import cohen_kappa_score  # included with sklearn? else use manual
_to_int = lambda s: (s.astype(float) * 2).round().astype(int)  # 0, 0.5, 1 -> 0, 1, 2
try:
    kappa_overall = cohen_kappa_score(_to_int(ag["fuzzy_bin"]), _to_int(ag["judge"]), weights="linear")
except Exception as e:
    kappa_overall = stats.spearmanr(ag["fuzzy_bin"], ag["judge"]).correlation

spearman_overall = stats.spearmanr(ag["fuzzy"], ag["judge"]).correlation

per_model = []
for model in ag["model"].unique():
    sub = ag[ag["model"] == model]
    try:
        k = cohen_kappa_score(_to_int(sub["fuzzy_bin"]), _to_int(sub["judge"]), weights="linear")
    except Exception:
        k = np.nan
    s = stats.spearmanr(sub["fuzzy"], sub["judge"]).correlation
    per_model.append({"model": model, "n": len(sub), "weighted_kappa": k, "spearman": s})
agree_df = pd.DataFrame(per_model)
agree_df.to_csv(TABLES / "6_fuzzy_judge_agreement.csv", index=False)

fig, axes = plt.subplots(1, 2, figsize=(13, 5))
# Hexbin: fuzzy vs judge
hb = axes[0].hexbin(ag["fuzzy"], ag["judge"] + np.random.uniform(-0.04, 0.04, len(ag)),
                    gridsize=30, cmap="viridis", mincnt=1)
plt.colorbar(hb, ax=axes[0], label="density")
axes[0].set_xlabel("Fuzzy score")
axes[0].set_ylabel("Judge score (jittered)")
axes[0].set_title(f"Fuzzy vs judge — Spearman ρ = {spearman_overall:.2f}, κw = {kappa_overall:.2f}")
axes[0].set_ylim(-0.1, 1.1)

# Disagreement: where fuzzy and judge_bin differ
ag["abs_disagree"] = np.abs(ag["fuzzy_bin"] - ag["judge"])
disagree = ag.groupby(["model", "system"])["abs_disagree"].mean().reset_index()
disagree_pv = disagree.pivot(index="system", columns="model", values="abs_disagree").reindex(index=SYSTEMS)
sns.heatmap(disagree_pv, annot=True, fmt=".2f", cmap="Reds", ax=axes[1], cbar_kws={"label": "Mean |fuzzy_bin − judge|"})
axes[1].set_title("Fuzzy/judge disagreement per system × model")
plt.savefig(PLOTS / "6_fuzzy_vs_judge.png")
plt.close()


# ─────────────────────────────────────────────────────────────────────────────
# 7. Cost-effectiveness: cost vs judge per system × model
# ─────────────────────────────────────────────────────────────────────────────

ce = df.dropna(subset=["cost_usd"]).groupby(["model", "system"]).agg(
    judge_mean=("judge", "mean"),
    cost_mean=("cost_usd", "mean"),
    cost_total=("cost_usd", "sum"),
    n=("judge", "count"),
).reset_index()
ce.to_csv(TABLES / "7_cost_effectiveness.csv", index=False)

fig, ax = plt.subplots(figsize=(8, 6))
for model in ce["model"].unique():
    sub = ce[ce["model"] == model]
    ax.scatter(sub["cost_mean"], sub["judge_mean"], s=120,
               label=model, color=MODEL_PALETTE.get(model, "gray"), edgecolor="black")
    for _, r in sub.iterrows():
        ax.annotate(r["system"], (r["cost_mean"], r["judge_mean"]),
                    textcoords="offset points", xytext=(7, 4), fontsize=8)
ax.set_xscale("log")
ax.set_xlabel("Mean cost per question (USD, log scale)")
ax.set_ylabel("Mean judge score")
ax.set_title("Cost-effectiveness: accuracy vs $/question per (model × system)")
ax.legend(loc="best")
ax.grid(True, alpha=0.3)
plt.savefig(PLOTS / "7_cost_effectiveness.png")
plt.close()


# ─────────────────────────────────────────────────────────────────────────────
# 8. Error patterns: gt_suspect, over_answered, refusal-when-data-exists rates
# ─────────────────────────────────────────────────────────────────────────────

flags = df.groupby(["model", "system"]).agg(
    gt_suspect_rate=("gt_suspect", "mean"),
    over_answered_rate=("over_answered", "mean"),
    n=("judge", "count"),
).reset_index()
flags.to_csv(TABLES / "8_flag_rates.csv", index=False)

fig, axes = plt.subplots(1, 2, figsize=(14, 5), sharey=True)
for ax, col, title in zip(axes, ["gt_suspect_rate", "over_answered_rate"],
                          ["Rate of gt_suspect=true", "Rate of over_answered=true"]):
    pv = flags.pivot(index="system", columns="model", values=col).reindex(index=SYSTEMS)
    sns.heatmap(pv, annot=True, fmt=".2%", cmap="OrRd", ax=ax, cbar=False, linewidths=0.5)
    ax.set_title(title)
plt.savefig(PLOTS / "8_flag_rates.png")
plt.close()


# ─────────────────────────────────────────────────────────────────────────────
# 9. Cross-model comparison on shared questions (Claude vs Qwen vs Llama-host)
# ─────────────────────────────────────────────────────────────────────────────

cross = []
hosted = df[df["model"].isin(["claude-haiku-4-5", "qwen-2.5-72b", "llama-3.1-8b"])]
for (system, tier), g in hosted.groupby(["system", "tier"]):
    pv = g.pivot_table(index="qid", columns="model", values="judge", aggfunc="mean").dropna()
    if pv.shape[0] < 5 or pv.shape[1] < 3:
        continue
    stat, p = stats.friedmanchisquare(*[pv[c].values for c in pv.columns])
    cross.append({
        "system": system, "tier": tier, "n_questions": pv.shape[0],
        "claude_mean": pv.get("claude-haiku-4-5", pd.Series()).mean(),
        "qwen_mean": pv.get("qwen-2.5-72b", pd.Series()).mean(),
        "llama_mean": pv.get("llama-3.1-8b", pd.Series()).mean(),
        "chi2": stat, "p": p,
    })
cross_df = pd.DataFrame(cross)
cross_df.to_csv(TABLES / "9_cross_model_friedman.csv", index=False)


# ─────────────────────────────────────────────────────────────────────────────
# 9b. Headline overall accuracy per (model × tier)
# ─────────────────────────────────────────────────────────────────────────────

headline = df.groupby(["model", "tier"])["judge"].agg(["mean", "count"]).reset_index()
fig, ax = plt.subplots(figsize=(10, 5))
models_order = ["claude-haiku-4-5", "qwen-2.5-72b", "llama-3.1-8b"]
tier_pos = {200: 0, 2000: 1, 20000: 2}
bar_width = 0.2
for i, model in enumerate(models_order):
    sub = headline[headline["model"] == model].sort_values("tier")
    if sub.empty:
        continue
    xs = [tier_pos[t] + (i - 1.0) * bar_width for t in sub["tier"]]
    bars = ax.bar(xs, sub["mean"], width=bar_width, label=model,
                  color=MODEL_PALETTE.get(model, "gray"), edgecolor="black", linewidth=0.5)
    for x, y, n in zip(xs, sub["mean"], sub["count"]):
        ax.text(x, y + 0.01, f"{y*100:.0f}%", ha="center", fontsize=8)
        ax.text(x, -0.04, f"n={n}", ha="center", fontsize=7, color="gray")
ax.set_xticks([0, 1, 2])
ax.set_xticklabels(["tier-200", "tier-2K", "tier-20K"])
ax.set_ylabel("Mean judge score (all systems × types pooled)")
ax.set_ylim(0, 1.0)
ax.set_title("Headline accuracy per model × tier")
ax.legend(loc="upper right")
plt.savefig(PLOTS / "9_headline_accuracy.png")
plt.close()


# ─────────────────────────────────────────────────────────────────────────────
# 9c. Stacked bars: distribution of judge scores per (model × system)
# ─────────────────────────────────────────────────────────────────────────────

dist = df.groupby(["model", "system"])["judge"].apply(
    lambda x: pd.Series({
        "pct_full":   (x == 1.0).mean(),
        "pct_partial":(x == 0.5).mean(),
        "pct_zero":   (x == 0.0).mean(),
    })
).unstack().reset_index()
dist.to_csv(TABLES / "11_score_distribution.csv", index=False)

fig, axes = plt.subplots(1, 3, figsize=(15, 5), sharey=True)
for ax, model in zip(axes, models_order):
    sub = dist[dist["model"] == model].set_index("system").reindex(SYSTEMS).dropna()
    if sub.empty:
        ax.set_visible(False); continue
    ax.bar(sub.index, sub["pct_full"], color="#2a9d8f", label="1.0 (correct)")
    ax.bar(sub.index, sub["pct_partial"], bottom=sub["pct_full"], color="#e9c46a", label="0.5 (partial)")
    ax.bar(sub.index, sub["pct_zero"],
           bottom=sub["pct_full"] + sub["pct_partial"], color="#e76f51", label="0 (wrong)")
    ax.set_title(model)
    ax.set_ylim(0, 1)
    ax.tick_params(axis="x", rotation=30)
    for i, s in enumerate(sub.index):
        full = sub.loc[s, "pct_full"]
        ax.text(i, full / 2, f"{full*100:.0f}%", ha="center", color="white", fontsize=8, weight="bold")
axes[0].set_ylabel("Fraction of cells")
axes[-1].legend(loc="center left", bbox_to_anchor=(1.02, 0.5))
fig.suptitle("Judge-score distribution per system (model panels)", y=1.02)
plt.savefig(PLOTS / "10_score_distribution.png")
plt.close()


# ─────────────────────────────────────────────────────────────────────────────
# 9d. Latency boxplots per (model × system)
# ─────────────────────────────────────────────────────────────────────────────

lat = df.dropna(subset=["latency_ms"]).copy()
lat["latency_s"] = lat["latency_ms"].astype(float) / 1000.0

fig, axes = plt.subplots(1, 3, figsize=(15, 5), sharey=True)
for ax, model in zip(axes, models_order):
    sub = lat[lat["model"] == model]
    if sub.empty:
        ax.set_visible(False); continue
    data = [sub[sub["system"] == s]["latency_s"].values for s in SYSTEMS]
    bp = ax.boxplot(data, labels=SYSTEMS, showfliers=False, patch_artist=True)
    for patch, system in zip(bp["boxes"], SYSTEMS):
        patch.set_facecolor(SYSTEM_PALETTE[system])
        patch.set_alpha(0.7)
    ax.set_title(model)
    ax.tick_params(axis="x", rotation=30)
    ax.grid(True, axis="y", alpha=0.3)
axes[0].set_ylabel("Latency per question (s)")
fig.suptitle("Latency distribution per system (outliers hidden)", y=1.02)
plt.savefig(PLOTS / "11_latency.png")
plt.close()

lat_summary = lat.groupby(["model", "system"])["latency_s"].agg(["median", "mean", "count"]).reset_index()
lat_summary.to_csv(TABLES / "12_latency.csv", index=False)


# ─────────────────────────────────────────────────────────────────────────────
# 9e. Tool-using vs llm-only gap (the headline cross-model finding)
# ─────────────────────────────────────────────────────────────────────────────

tool_systems = ["graph", "sql-t2s", "graph-cypher"]
gap = []
for (model, tier), g in df.groupby(["model", "tier"]):
    tool = g[g["system"].isin(tool_systems)]["judge"]
    llm = g[g["system"] == "llm-only"]["judge"]
    if len(tool) == 0 or len(llm) == 0:
        continue
    gap.append({
        "model": model, "tier": tier,
        "tool_mean": tool.mean(),
        "llm_only_mean": llm.mean(),
        "gap": tool.mean() - llm.mean(),
        "n_tool": len(tool), "n_llm": len(llm),
    })
gap_df = pd.DataFrame(gap)
gap_df.to_csv(TABLES / "13_tool_vs_llmonly_gap.csv", index=False)

fig, ax = plt.subplots(figsize=(10, 5))
for i, model in enumerate(models_order):
    sub = gap_df[gap_df["model"] == model].sort_values("tier")
    if sub.empty: continue
    xs = [tier_pos[t] + (i - 1.5) * 0.2 for t in sub["tier"]]
    ax.bar(xs, sub["gap"], width=0.2, color=MODEL_PALETTE.get(model, "gray"),
           edgecolor="black", linewidth=0.5, label=model)
    for x, y in zip(xs, sub["gap"]):
        ax.text(x, y + 0.005 if y >= 0 else y - 0.02, f"{y*100:+.0f}pp", ha="center", fontsize=8)
ax.axhline(0, color="black", linewidth=0.8)
ax.set_xticks([0, 1, 2]); ax.set_xticklabels(["tier-200", "tier-2K", "tier-20K"])
ax.set_ylabel("Tool-using mean − llm-only mean (pp)")
ax.set_title("Tool-using paradigms widen the model-capability gap")
ax.legend(loc="upper right")
ax.grid(True, axis="y", alpha=0.3)
plt.savefig(PLOTS / "12_tool_vs_llmonly_gap.png")
plt.close()


# ─────────────────────────────────────────────────────────────────────────────
# 9f. Per-question best-system count (which system wins each question?)
# ─────────────────────────────────────────────────────────────────────────────

wins_rows = []
for (model, tier), g in df.groupby(["model", "tier"]):
    pv = g.pivot_table(index="qid", columns="system", values="judge", aggfunc="mean").dropna()
    for qid, row in pv.iterrows():
        best_score = row.max()
        winners = row[row == best_score].index.tolist()
        # Award fractional win when multiple systems tie
        for w in winners:
            wins_rows.append({"model": model, "tier": tier, "system": w, "win_share": 1.0 / len(winners)})

wins = pd.DataFrame(wins_rows)
wins_pivot = wins.groupby(["model", "tier", "system"])["win_share"].sum().reset_index()
totals = wins.groupby(["model", "tier"])["win_share"].sum().reset_index().rename(columns={"win_share": "total"})
wins_pivot = wins_pivot.merge(totals, on=["model", "tier"])
wins_pivot["win_rate"] = wins_pivot["win_share"] / wins_pivot["total"]
wins_pivot.to_csv(TABLES / "14_win_rate.csv", index=False)

fig, axes = plt.subplots(1, 3, figsize=(15, 5), sharey=True)
for ax, model in zip(axes, models_order):
    sub = wins_pivot[wins_pivot["model"] == model]
    if sub.empty: ax.set_visible(False); continue
    pv = sub.pivot(index="system", columns="tier", values="win_rate").reindex(SYSTEMS).fillna(0)
    pv.plot(kind="bar", ax=ax, color=["#264653", "#2a9d8f", "#e9c46a"], edgecolor="black", width=0.8)
    ax.set_title(model)
    ax.set_ylim(0, 0.6)
    ax.set_xlabel("")
    ax.tick_params(axis="x", rotation=30)
    ax.legend(title="tier", loc="upper right", fontsize=8)
axes[0].set_ylabel("Win rate (best-or-tied)")
fig.suptitle("Which system wins each question? (per model × tier)", y=1.02)
plt.savefig(PLOTS / "13_win_rate.png")
plt.close()


# ─────────────────────────────────────────────────────────────────────────────
# 9g. Turns distribution (tool-loop length) per system
# ─────────────────────────────────────────────────────────────────────────────

turns = df.dropna(subset=["turns"]).copy()
turns["turns"] = turns["turns"].astype(float)
fig, axes = plt.subplots(1, 3, figsize=(15, 5), sharey=True)
for ax, model in zip(axes, models_order):
    sub = turns[turns["model"] == model]
    if sub.empty: ax.set_visible(False); continue
    data = [sub[sub["system"] == s]["turns"].values for s in SYSTEMS]
    bp = ax.boxplot(data, labels=SYSTEMS, showfliers=False, patch_artist=True)
    for patch, system in zip(bp["boxes"], SYSTEMS):
        patch.set_facecolor(SYSTEM_PALETTE[system])
        patch.set_alpha(0.7)
    ax.set_title(model)
    ax.tick_params(axis="x", rotation=30)
    ax.grid(True, axis="y", alpha=0.3)
axes[0].set_ylabel("Tool-call turns per question")
fig.suptitle("Tool-loop length per system (outliers hidden)", y=1.02)
plt.savefig(PLOTS / "14_turns.png")
plt.close()


# ─────────────────────────────────────────────────────────────────────────────
# 10. Summary table for the writeup
# ─────────────────────────────────────────────────────────────────────────────

summary = df.groupby(["model", "tier"]).agg(
    n_cells=("judge", "count"),
    judge_mean=("judge", "mean"),
    pct_full=("judge", lambda x: (x == 1.0).mean()),
    pct_partial=("judge", lambda x: (x == 0.5).mean()),
    pct_zero=("judge", lambda x: (x == 0.0).mean()),
).reset_index()
summary.to_csv(TABLES / "10_top_summary.csv", index=False)


# ─────────────────────────────────────────────────────────────────────────────
# Derived tables for the writeup
# ─────────────────────────────────────────────────────────────────────────────

# Best paradigm per (model, tier) — accuracy + n
best_paradigm = []
for (model, tier), g in df.groupby(["model", "tier"]):
    sys_means = g.groupby("system")["judge"].mean()
    s = sys_means.idxmax()
    best_paradigm.append({
        "model": model, "tier": tier, "best_system": s,
        "best_judge_mean": sys_means[s],
        "pooled_judge_mean": g["judge"].mean(),
        "n_total": len(g),
    })
best_paradigm_df = pd.DataFrame(best_paradigm).sort_values(["model", "tier"])
best_paradigm_df.to_csv(TABLES / "15_best_paradigm_per_model.csv", index=False)

# Best system per type per model
best_type = []
for (model, q_type), g in df.groupby(["model", "type"]):
    sys_means = g.groupby("system")["judge"].mean()
    if len(sys_means) == 0:
        continue
    best_s = sys_means.idxmax()
    best_type.append({
        "model": model, "type": q_type,
        "best_system": best_s, "best_score": sys_means[best_s],
        "second_system": sys_means.sort_values(ascending=False).index[1] if len(sys_means) > 1 else None,
        "second_score": sys_means.sort_values(ascending=False).iloc[1] if len(sys_means) > 1 else np.nan,
    })
best_type_df = pd.DataFrame(best_type)
best_type_df.to_csv(TABLES / "16_best_system_per_type.csv", index=False)

# Flagged GT issues — list of (qid, type, count_flagged)
gt_flags = df[df["gt_suspect"]].groupby(["qid", "type"]).size().reset_index(name="n_flags")
gt_flags = gt_flags.sort_values("n_flags", ascending=False)
gt_flags.to_csv(TABLES / "17_gt_flagged_questions.csv", index=False)


# ─────────────────────────────────────────────────────────────────────────────
# Write the report
# ─────────────────────────────────────────────────────────────────────────────

def fmt_pct(x): return f"{x*100:.1f}%"

md = []

# ─── §1 Setup ────────────────────────────────────────────────────────────────
md.append("# Paradigm Comparison for Clinical EHR Question-Answering\n")
md.append("## §1. Setup & methodology\n")
md.append(f"Five retrieval paradigms answered each of 334 questions across three models (Claude Haiku 4.5, Qwen 2.5 72B, Llama 3.1 8B) and three patient-cohort tiers (200, 2 000, 20 000). Each (question, model, tier, system) cell received a 3-level score (0, 0.5, 1) from a hand-reasoned LLM-as-judge applying the rubric in `docs/judge-calibration.md` (17 adjudicated calibration cases). Final dataset: **{len(df):,} judged cells**.\n")
md.append("\n![pipeline](plots/0_pipeline.png)\n")
md.append("\n**Cells per (model × tier):**\n")
md.append("| Model | tier-200 | tier-2K | tier-20K |")
md.append("|---|---:|---:|---:|")
counts = df.groupby(["model","tier"]).size().unstack(fill_value=0)
for model in counts.index:
    row = counts.loc[model]
    md.append(f"| {model} | {row.get(200, 0):,} | {row.get(2000, 0):,} | {row.get(20000, 0):,} |")

# ─── §2 Headline ─────────────────────────────────────────────────────────────
md.append("\n## §2. Top-line accuracy\n")
md.append("Pooled judge-mean across all 5 systems and all 6 question types, per (model × tier):\n")
md.append("\n![headline](plots/9_headline_accuracy.png)\n")
md.append("\n| Model | Tier | n | Judge mean | % full | % partial | % wrong |")
md.append("|---|---|---:|---:|---:|---:|---:|")
for _, r in summary.iterrows():
    md.append(f"| {r['model']} | {r['tier']} | {r['n_cells']:,} | {r['judge_mean']:.3f} | {fmt_pct(r['pct_full'])} | {fmt_pct(r['pct_partial'])} | {fmt_pct(r['pct_zero'])} |")

md.append("\n*Interpretation:* Claude leads at every tier; Qwen ranks second; Llama trails by a wide margin under the pooled view because tool-using systems contribute many zeros for that model.\n")

md.append("\n**Best paradigm per (model × tier)** — the practical view if you deploy only the strongest system for each model:\n")
md.append("\n| Model | Tier | Best system | Best judge mean | Pooled mean (all 5 systems) |")
md.append("|---|---|---|---:|---:|")
for _, r in best_paradigm_df.iterrows():
    md.append(f"| {r['model']} | {r['tier']} | {r['best_system']} | {r['best_judge_mean']:.3f} | {r['pooled_judge_mean']:.3f} |")
md.append("\n*Interpretation:* once each model picks its best paradigm, the headline gap narrows but remains large: Claude ≈ 0.85, Qwen ≈ 0.75, Llama ≈ 0.55–0.62 (sql-fts wins for Llama because of its tool-calling failure mode).\n")

# ─── §3 Metric validity ──────────────────────────────────────────────────────
md.append("\n## §3. Metric validity: fuzzy vs hand-judge\n")
md.append("The original automated metric is a fuzzy token-overlap score against the ground-truth string. The LLM judge applies a hand-reasoned clinical rubric. The judge is the metric used everywhere else in this report; this section documents agreement between the two.\n")
md.append("\n![fuzzy vs judge](plots/6_fuzzy_vs_judge.png)\n")
md.append(f"\nOverall: Spearman ρ = **{spearman_overall:.2f}**, weighted κ (3-level) = **{kappa_overall:.2f}**.\n")
md.append("\n| Model | n | Spearman ρ | Weighted κ |")
md.append("|---|---:|---:|---:|")
for _, r in agree_df.iterrows():
    md.append(f"| {r['model']} | {r['n']:,} | {r['spearman']:.2f} | {r['weighted_kappa']:.2f} |")
md.append("\n*Interpretation:* moderate agreement only (κ ≈ 0.44–0.52). The fuzzy scorer systematically penalises long-form clinical answers and fails to recognise correct UNANSWERABLE refusals, so we use the judge throughout this report.\n")

# ─── §4 Paradigm ranking ─────────────────────────────────────────────────────
md.append("\n## §4. Paradigm ranking per (model × tier)\n")
md.append("System means with 95% bootstrap CIs:\n")
md.append("\n![system means](plots/1_system_means.png)\n")
md.append("\nFailure-mode breakdown — fraction of cells scoring 1.0, 0.5, and 0:\n")
md.append("\n![score distribution](plots/10_score_distribution.png)\n")
md.append("\n| Model | Tier | System | n | Mean | 95% CI |")
md.append("|---|---|---|---:|---:|---|")
for _, r in desc_df.iterrows():
    md.append(f"| {r['model']} | {r['tier']} | {r['system']} | {r['n']} | {r['mean']:.3f} | [{r['ci_lo']:.3f}, {r['ci_hi']:.3f}] |")
md.append("\n*Interpretation:* for Claude and Qwen, sql-t2s consistently ranks first and sql-fts last; graph and graph-cypher are statistically indistinguishable from each other. For Llama, the ordering flips entirely: sql-fts and llm-only are best, the three tool-using systems collapse to 10–20%.\n")

# ─── §5 Statistical tests ────────────────────────────────────────────────────
md.append("\n## §5. Statistical confirmation of the ranking\n")
md.append("Four tests, sequenced omnibus → pairwise, with each available in both ordinal and binary form.\n")

md.append("\n### §5.1 Friedman (ordinal omnibus)\n")
md.append("H₀: all five systems have the same distribution of judge scores on the same questions.\n")
md.append("\n| Model | Tier | n questions | χ² | p |")
md.append("|---|---|---:|---:|---:|")
for _, r in fried_df.iterrows():
    md.append(f"| {r['model']} | {r['tier']} | {r['n_questions']} | {r['chi2']:.1f} | {r['p']:.2e} |")
md.append("\n*Interpretation:* every combination rejects H₀ at p ≪ 0.001 — at least one system differs.\n")

md.append("\n### §5.2 Cochran's Q (binary omnibus)\n")
md.append("Same hypothesis as Friedman but with the judge score binarised. Strict cutoff = `judge == 1.0`; lenient cutoff = `judge ≥ 0.5`.\n")
md.append("\n| Cutoff | Model | Tier | n | k | Q | p |")
md.append("|---|---|---|---:|---:|---:|---:|")
for _, r in cochran_df.iterrows():
    md.append(f"| {r['cutoff']} | {r['model']} | {r['tier']} | {r['n_questions']} | {r['n_systems']} | {r['Q']:.1f} | {r['p']:.2e} |")
md.append("\n*Interpretation:* Cochran's Q rejects H₀ at p ≪ 0.001 in all 18 combinations (9 × 2 cutoffs) — the binary framing confirms the ordinal one.\n")

md.append("\n### §5.3 Pairwise Wilcoxon signed-rank (ordinal, Bonferroni-corrected)\n")
md.append("Each cell shows mean(row) − mean(col). Stars: `*p<.05, **p<.01, ***p<.001`.\n")
md.append("\n![pairwise heatmaps](plots/3_pairwise_heatmaps.png)\n")
md.append("\nFull table with Cliff's δ effect sizes: `tables/3_pairwise_wilcoxon.csv`.\n")
md.append("\n*Interpretation:* for Claude and Qwen, sql-t2s significantly beats every other system in nearly every (tier) combination. For Llama, sql-fts and llm-only significantly beat the three tool-using systems by 30–55 percentage points.\n")

md.append("\n### §5.4 Pairwise McNemar (binary, Bonferroni-corrected)\n")
md.append("Strict cutoff:\n\n![mcnemar strict](plots/3b_mcnemar_strict.png)\n")
md.append("\nLenient cutoff:\n\n![mcnemar lenient](plots/3c_mcnemar_lenient.png)\n")
md.append("\nFull McNemar table with discordant-pair counts (b/c): `tables/3c_mcnemar_pairs.csv`.\n")
md.append("\n*Interpretation:* McNemar agrees with Wilcoxon — the same pairs are significant under both cutoffs, with effect sizes 5–55 percentage points.\n")

# ─── §6 Type × system ────────────────────────────────────────────────────────
md.append("\n## §6. Where each paradigm wins (question type × system)\n")
md.append("Mean judge score per (model × type × system), pooled across tiers:\n")
md.append("\n![type-system heatmap](plots/5_type_system_heatmap.png)\n")
md.append("\n**Best paradigm per (model × question type)** — derived from the heatmap:\n")
md.append("\n| Type | Claude best (score) | Qwen best (score) | Llama best (score) |")
md.append("|---|---|---|---|")
type_order_present = [t for t in TYPE_ORDER if t in best_type_df["type"].unique()]
for t in type_order_present:
    sub = best_type_df[best_type_df["type"] == t].set_index("model")
    def cell(model):
        if model not in sub.index: return "—"
        r = sub.loc[model]
        return f"{r['best_system']} ({r['best_score']:.2f})"
    md.append(f"| {t} | {cell('claude-haiku-4-5')} | {cell('qwen-2.5-72b')} | {cell('llama-3.1-8b')} |")
md.append("\n*Interpretation:* sql-t2s wins the most type slots for capable models; graph wins specifically on cohort. For Llama every type's winner is sql-fts or llm-only (i.e. the non-tool-using paths).\n")

# ─── §7 Scaling ──────────────────────────────────────────────────────────────
md.append("\n## §7. Scaling across cohort sizes\n")
md.append("Mean judge score per (model × system) across the three patient-cohort tiers:\n")
md.append("\n![scaling curves](plots/4_scaling_curves.png)\n")
md.append("\n**Linear regression of judge on log₁₀(tier):**\n")
md.append("\n| Model | System | Slope per log₁₀ tier | 95% CI | r | p |")
md.append("|---|---|---:|---|---:|---:|")
for _, r in scaling_df.iterrows():
    md.append(f"| {r['model']} | {r['system']} | {r['slope_per_log10_tier']:+.3f} | [{r['ci_lo']:+.3f}, {r['ci_hi']:+.3f}] | {r['r']:+.2f} | {r['p']:.2e} |")
md.append("\n*Interpretation:* slopes are small (|slope| < 0.05 in every case); CIs for most slopes cross zero. No paradigm shows pronounced accuracy degradation from 200 to 20 000 patients.\n")

# ─── §8 Cross-model gap ──────────────────────────────────────────────────────
md.append("\n## §8. Cross-model comparison on shared questions\n")
md.append("**Tool-using mean − llm-only mean**, per (model × tier):\n")
md.append("\n![tool vs llm-only gap](plots/12_tool_vs_llmonly_gap.png)\n")
md.append("\n**Win rate** — fraction of questions where each system is best-or-tied:\n")
md.append("\n![win rate](plots/13_win_rate.png)\n")
md.append("\n**Friedman test on shared questions** (Claude vs Qwen vs Llama, paired per question):\n")
md.append("\n| System | Tier | n | Claude | Qwen | Llama | χ² | p |")
md.append("|---|---|---:|---:|---:|---:|---:|---:|")
for _, r in cross_df.sort_values(["system","tier"]).iterrows():
    md.append(f"| {r['system']} | {r['tier']} | {r['n_questions']} | {r['claude_mean']:.2f} | {r['qwen_mean']:.2f} | {r['llama_mean']:.2f} | {r['chi2']:.1f} | {r['p']:.2e} |")
md.append("\n*Interpretation:* tool-using paradigms give Claude +16 to +20pp over llm-only, give Qwen approximately zero net change, and cost Llama −42 to −52pp. The model-capability gap on the same questions is far larger for tool-using paradigms than for llm-only.\n")

# ─── §9 Operational tradeoffs ────────────────────────────────────────────────
md.append("\n## §9. Operational tradeoffs: latency and tool-loop length\n")
md.append("Per-question latency in seconds (boxplots, outliers hidden):\n")
md.append("\n![latency](plots/11_latency.png)\n")
md.append("\nTool-loop length (number of LLM↔tool turns; only tool-using systems):\n")
md.append("\n![turns](plots/14_turns.png)\n")
md.append("\n**Median latency per (model × system):**\n")
md.append("\n| Model | System | n | Median (s) | Mean (s) |")
md.append("|---|---|---:|---:|---:|")
for _, r in lat_summary.iterrows():
    md.append(f"| {r['model']} | {r['system']} | {int(r['count'])} | {r['median']:.1f} | {r['mean']:.1f} |")
md.append("\n*Interpretation:* sql-fts and llm-only are single-turn and fastest (~2–6 s median). Tool-using systems take several LLM↔tool turns; Qwen graph-cypher runs longest (~36 s median) because of repeated query-fix loops.\n")

# ─── §10 Error patterns ──────────────────────────────────────────────────────
md.append("\n## §10. Error patterns and threats to validity\n")
md.append("Two flags emitted alongside the judge score: `gt_suspect` (judge believes the ground truth is wrong) and `over_answered` (correct facts present but buried in extras).\n")
md.append("\n![flag rates](plots/8_flag_rates.png)\n")

md.append("\n**Recurring GT issues flagged across multiple cells** (top 15 by flag count):\n")
md.append("\n| QID | Type | Times flagged |")
md.append("|---|---|---:|")
for _, r in gt_flags.head(15).iterrows():
    md.append(f"| {r['qid']} | {r['type']} | {r['n_flags']} |")
md.append("\n*Interpretation:* the most-flagged questions cluster in cohort (COH-23/24/26/27/28/29 — numeric mismatches), unanswerable (UNA-108 — income IS in Synthea), and reasoning (RSN-54/56/76 — over-narrow guideline GTs). These are dataset issues, not system failures.\n")

# ─── §11 Files manifest ──────────────────────────────────────────────────────
md.append("\n## §11. Files manifest\n")
md.append("| File | Description |")
md.append("|---|---|")
md.append("| `tables/long_format.csv` | Every judged cell — the master file for re-analysis |")
md.append("| `tables/1_descriptive_means.csv` | System means + 95% bootstrap CIs |")
md.append("| `tables/2_friedman.csv` | Friedman omnibus test per (model, tier) |")
md.append("| `tables/3_pairwise_wilcoxon.csv` | Pairwise Wilcoxon + Cliff's δ + Bonferroni p |")
md.append("| `tables/3b_cochran_q.csv` | Cochran's Q omnibus (strict + lenient cutoffs) |")
md.append("| `tables/3c_mcnemar_pairs.csv` | Pairwise McNemar with b/c counts |")
md.append("| `tables/4_scaling_regression.csv` | log-tier regression slopes |")
md.append("| `tables/5_type_system_means.csv` | Mean judge per (model, type, system) |")
md.append("| `tables/6_fuzzy_judge_agreement.csv` | Spearman + weighted κ per model |")
md.append("| `tables/8_flag_rates.csv` | gt_suspect + over_answered rates |")
md.append("| `tables/12_latency.csv` | Median + mean latency per (model, system) |")
md.append("| `tables/9_cross_model_friedman.csv` | Friedman across models per (system, tier) |")
md.append("| `tables/10_top_summary.csv` | Top-line summary used in §2 |")
md.append("| `tables/15_best_paradigm_per_model.csv` | Best system per (model, tier) for §2 |")
md.append("| `tables/16_best_system_per_type.csv` | Best system per (model, type) for §6 |")
md.append("| `tables/17_gt_flagged_questions.csv` | GT-suspect counts per question |")

md.append("\n### Schema of `long_format.csv`\n")
md.append("| Column | Type | Description |")
md.append("|---|---|---|")
md.append("| `model` | str | claude-haiku-4-5 / qwen-2.5-72b / llama-3.1-8b |")
md.append("| `tier` | int | 200 / 2000 / 20000 patient-cohort size |")
md.append("| `system` | str | graph / sql-fts / sql-t2s / llm-only / graph-cypher |")
md.append("| `qid` | str | Question identifier (e.g. SL-19, COH-14) |")
md.append("| `type` | str | simple-lookup / cohort / temporal / multi-hop / reasoning / unanswerable |")
md.append("| `judge` | float | 0.0, 0.5, or 1.0 — primary outcome |")
md.append("| `fuzzy` | float | Original token-overlap score; secondary outcome |")
md.append("| `latency_ms` | float | End-to-end latency for the system's answer |")
md.append("| `cost_usd` | float | API cost (Claude only; OpenRouter omits) |")
md.append("| `turns` | int | Number of LLM↔tool turns (tool-using systems only) |")
md.append("| `gt_suspect` | bool | Judge flagged the ground-truth as suspect |")
md.append("| `over_answered` | bool | Judge flagged answer as containing correct facts amid significant unrelated content |")

(OUT / "ANALYSIS.md").write_text("\n".join(md))
print("\nWrote", OUT / "ANALYSIS.md")
print("Plots at", PLOTS)
print("Tables at", TABLES)
