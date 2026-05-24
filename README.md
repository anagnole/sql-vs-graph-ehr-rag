# EHR-Clinical-Assistant

Companion code and data for the paper **"Knowledge Graphs vs. SQL Over Structured EHR Data"** (Anagnou et al., *Future Internet*, 2026).

A controlled benchmark comparing **five retrieval approaches** for clinical question answering over Synthea EHRs, evaluated across **three models** and **three nested cohort sizes**.

[![Demo](docs/demo-screenshot.png)](https://youtu.be/X7BhfGabk70)
> **[Watch the clinical-assistant demo](https://youtu.be/X7BhfGabk70)** — Streaming chat with graph retrieval, document generation, and multi-model support.

## Experimental design

- **334 questions** across six categories (simple-lookup, multi-hop, temporal, cohort, reasoning, unanswerable)
- **5 retrieval approaches**:
  - `graph` — curated MCP tools over a Kuzu property graph
  - `graph-cypher` — LLM writes Cypher directly against the same graph
  - `sql-t2s` — LLM writes SQL against PostgreSQL
  - `sql-fts` — PostgreSQL full-text search via `to_tsquery`
  - `llm-only` — patient JSON snapshot in context, no retrieval
- **3 nested patient cohorts**: 200, 2 000, 20 000 patients (smaller cohorts strictly contained in larger ones)
- **3 language models**: Claude Haiku 4.5 (Anthropic), Qwen 2.5 72B Instruct (OpenRouter), Llama 3.1 8B Instruct (OpenRouter)
- **13 640 judged cells** scored by an LLM judge (Claude Haiku 4.5) on a 0 / 0.5 / 1 rubric, with a deterministic token-overlap cross-check

## Headline result (pooled across cohorts)

| Model | Best approach | Score |
|---|---|---|
| Claude Haiku 4.5 | `sql-t2s` (graph-cypher at 20K) | 0.83 – 0.88 |
| Qwen 2.5 72B | `sql-t2s` | 0.73 – 0.77 |
| Llama 3.1 8B | `sql-fts` | 0.59 – 0.68 |

**Model–capability interaction**: tool-using approaches add ~0.20 to Claude's mean judge score over the context-only baseline, but *reduce* Llama's accuracy by ~0.45 due to tool-call protocol failures.

**Scaling null result**: no approach degrades meaningfully as the cohort grows from 200 to 20 000 patients — the ranking established at the 200-patient prototype tier generalises to 20 000.

Full statistical analysis (Friedman / Wilcoxon / Cliff's δ / bootstrap CIs) and per-question-type breakdowns are in [`docs/analysis/v2/`](docs/analysis/v2/).

## Architecture

```
Synthea (20,000 patients, seed 42)
        │
        ▼
┌───────────────┐     ┌────────────────┐
│  CSV Parser    │────▶│  JSON snapshots │  per-patient ground-truth
└───────────────┘     └────────┬───────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                 ▼
     ┌──────────────┐  ┌─────────────────┐  ┌──────────────┐
     │  Kuzu graph   │  │ PostgreSQL +FTS │  │  JSON in ctx  │
     │  (3 tiers)    │  │  (3 tiers)      │  │  (3 tiers)    │
     └──────┬───────┘  └────────┬────────┘  └──────┬───────┘
            │                   │                   │
            ▼                   ▼                   ▼
     ┌──────────────────────────────────────────────────────┐
     │  Evaluation harness (334 q × 5 approaches × 3 models  │
     │                       × 3 cohorts = 15 030 cells)     │
     │  Claude (MCP) | Qwen / Llama (OpenAI-compat tools)   │
     └─────────────────────────┬────────────────────────────┘
                               ▼
     ┌──────────────────────────────────────────────────────┐
     │  LLM-as-judge (Claude Haiku 4.5)                       │
     │  Three-level rubric (0 / 0.5 / 1) + over_answered     │
     │  + gt_suspect flags                                    │
     └──────────────────────────────────────────────────────┘
```

## Graph schema

**7 node tables**: Patient, Encounter, ConceptCondition, ConceptMedication, ConceptObservation, ConceptProcedure, Provider, Organization.

A shared-concept design: each distinct condition / medication / observation / procedure exists once as a concept node carrying its SNOMED / RxNorm / LOINC code; per-patient instances link via dedicated relationships. At the 20 000-patient tier the graph has 305 condition concepts, 356 medication concepts, 297 observation concepts and 412 procedure concepts against 11.9M observation instances — roughly a 100× node reduction vs. naïve per-patient duplication.

**12 relationships**: HAS_CONDITION, PRESCRIBED, MEASURED, UNDERWENT, HAD_ENCOUNTER, TREATED_BY, AT_ORGANIZATION, TREATS, COMPLICATION_OF, INDICATED_BY, REASON_FOR, …

FTS indexes on patient names, condition descriptions, medication names, and observation descriptions.

## Question bank

| Type | Count | Description |
|------|-------|-------------|
| simple-lookup | 72 | Single fact about a single patient |
| multi-hop | 58 | Chain two or more clinical relationships |
| temporal | 56 | Event ordering or interval reasoning |
| cohort | 60 | Identify or count patients matching combined criteria |
| reasoning | 60 | Integrate clinical context beyond a single field |
| unanswerable | 28 | Information absent from the cohort; correct response is refusal |

Questions are generated programmatically from per-category templates against the JSON ground truth, then filtered manually for ambiguity, degenerate ground truth, or trivial answer spaces. Each question carries its supporting record identifiers, so scoring is reproducible.

## Reproducing the paper

See **[REPRODUCING_PAPER.md](REPRODUCING_PAPER.md)** for the end-to-end walkthrough from `git clone` to Figure 2.

## Prerequisites

- Node.js ≥ 18
- Docker (for PostgreSQL)
- Synthea (`brew install synthea`) — used at seed 42 to produce 20 000 patients
- Claude CLI (for the Claude runs and MCP transport)
- An OpenRouter API key in `OPENROUTER_API_KEY` (for Qwen + Llama runs)
- Python ≥ 3.10 with `numpy pandas scipy seaborn matplotlib` (for the analysis scripts)

## Setup

```bash
npm install
npm run pg:up                      # PostgreSQL on :5432
```

## Pipeline

```bash
npm run generate                   # parse Synthea CSVs → JSON + 334-question bank
npm run ingest                     # load all three tiers into Kuzu
npm run pg:ingest                  # load all three tiers into PostgreSQL (+ FTS)
npm run verify                     # sanity-check graph counts and joins

# Evaluate — one approach × model × tier per invocation
npm run eval -- --model claude-haiku-4-5 --system graph        --tier 200
npm run eval -- --model claude-haiku-4-5 --system sql-t2s      --tier 2000
npm run eval -- --model qwen-2.5-72b     --system graph-cypher --tier 20000
# …repeat for all 5 × 3 × 3 = 45 combinations

# Score every cell and produce the analysis figures + tables
python3 scripts/analysis_v2.py
```

Outputs land in `docs/analysis/v2/{plots,tables}/` and mirror the paper's Figures 2–8 and Tables 2–4.

## MCP server

The graph-retrieval approach exposes 18 clinical tools to the LLM via the Model Context Protocol. The most-used ones:

| Tool | Purpose |
|------|---------|
| `search_patients` | Find patients by name or demographics |
| `get_patient_summary` | Full patient overview |
| `get_diagnoses` / `get_medications` / `get_labs` / `get_procedures` | Domain-scoped retrieval |
| `get_temporal_relation` | Time-ordering between clinical events |
| `find_cohort` / `count_cohort` | Population-level criteria matching |
| `rank_conditions_in_cohort` | Most common diagnoses in a group |
| `aggregate_observation_for_cohort` | Statistics for a lab/vital across a group |
| `list_treatments_for_condition` | Common medications for a diagnosis |

```bash
./start-mcp.sh
```

## Clinical-assistant UI

A doctor-facing chat interface with an interactive Sigma.js knowledge-graph view, used for the qualitative parts of the work (not the paper's quantitative benchmark).

```bash
npm run ui:dev                     # hot-reload dev server
npm run ui                         # production build
```

Features: model selector (Claude / Qwen / Llama via OpenRouter), streaming chat with tool-call visibility, force-directed knowledge graph, node-click context attachment, date filtering, document generation (referral letters, SOAP notes), clinical templates.

## Repository layout

```
├── data/
│   ├── synthea/          # Raw Synthea CSV output (gitignored)
│   ├── generated/        # JSON snapshots, question bank (gitignored)
│   ├── documents/        # Generated clinical documents
│   └── templates/        # Document templates
├── docs/
│   └── analysis/v2/      # Paper's figures, tables, statistical outputs
├── results/              # Raw eval output per (approach, model, tier) — gitignored
├── scripts/
│   ├── analysis_v2.py    # Statistical analysis + paper figures
│   └── curate-tiers.ts   # Cohort sub-sampling logic
├── src/
│   ├── generate.ts       # CSV → JSON snapshots + question bank
│   ├── ingest.ts         # JSON → Kuzu graph (per-tier)
│   ├── sql/              # PostgreSQL schema, ingestion, FTS variant
│   ├── questions/        # Generators for the 6 question categories
│   ├── eval/             # Evaluation runner, LLM-as-judge scorer
│   ├── prompt/           # System prompts per retrieval approach
│   ├── api/              # Fastify API + Kuzu client + MCP tools
│   └── ui/               # React + Sigma.js clinical UI
├── docker-compose.yml    # PostgreSQL 16
├── start-mcp.sh          # MCP server launcher
└── package.json
```

## Tech stack

- **TypeScript** + tsx — pipeline, evaluation harness
- **Kuzu** — embedded graph DB (Cypher)
- **PostgreSQL 16** — relational baseline + FTS variant
- **Claude CLI** + **OpenRouter** — three-model harness, unified via `@anagnole/claude-cli-wrapper`
- **MCP** — Model Context Protocol for the curated-graph approach
- **Synthea** — synthetic patient generation (seed 42)
- **Python 3 / pandas / scipy / seaborn** — statistical analysis and plotting
- **Fastify + React + Sigma.js** — clinical UI

## Citation

If you use this code, the question bank, or the per-tier databases, please cite:

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

## License

Released under CC BY 4.0 (paper) and MIT (code), consistent with MDPI's open-access policy.
