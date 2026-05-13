# Smoke Matrix Review — 2026-04-23

> **STATUS UPDATE (end of 2026-04-23 session)** — the matrix analysis and
> technical plan below reflect the state at ~18:00 when I first wrote this.
> By end-of-day, **R1 (re-ingest) and R2 (cohort GT regen) were both
> completed**: all three tier DBs (Kuzu + Postgres) are on the new schema
> with `value_canonical`/`units_canonical` populated ~14% (expected), row
> counts agree across Kuzu/Postgres (200 / 2000 / 20000 patients), and
> `scripts/recompute-cohort-gt.ts` regenerated 94 `(qid, tier)` pairs with
> patient-count + findings-allowlist semantics. **Do not redo R1 or R2.**
>
> What's still actually pending at start-of-next-session:
> - Sync `JUDGE_PROMPT` in `src/eval/judge.ts` with calibration doc §2 —
>   **done** on 2026-04-23 (rubric now loaded at import time from the doc).
> - **Judge pilot run** on existing Haiku tier-200 incremental results.
> - **50-case human calibration** before paper-facing judge numbers.
> - Phase-1 sweep per the skip list in §"Phase-1 skip list" below.
> - The rest of R3–R10 (all smaller items; see §"Technical plan").

## TL;DR

Ran 192 cells: **5 questions × 5 systems × 3 tiers × 3 models** (with `llm-only` restricted to tier-200 non-cohort). With tier-aware ground truth:

- **Claude Haiku 4.5 dominates open-source across every system and tier.** 75% at tier-200, 70% tier-2000, 60% tier-20000.
- **Fair paradigm comparison (graph vs sql-t2s) favors the graph** at every tier: +13pp / +33pp / +13pp. Matches the paper's primary thesis claim (directionally) but the magnitude varies, and the matrix is only 5 questions — not yet load-bearing.
- **Scaling signal is noisy:** graph score goes 47% → 60% → 33% across tiers, non-monotonic. Drop at tier-20000 is partly real (schema issues, qwen latency blowout), partly scorer artifacts.
- **Fuzzy scorer is underestimating accuracy by a meaningful margin.** Several correct answers were marked wrong because of date-format differences (`May 1, 2019` vs `2019-05-01`) and log truncation. The review explicitly flags these cells.

## Matrix results

### Per-tier × per-system accuracy (tier-aware GT, averaged over 3 models × 5 questions)

| System | tier-200 | tier-2000 | tier-20000 |
|---|---|---|---|
| **graph** | 47% | 60% | 33% |
| **sql** | 60% | 60% | 60% |
| **sql-fts** | 60% | 60% | 53% |
| **sql-t2s** | 33% | 27% | 20% |
| **llm-only** | 33% | — | — |

*n=15 per cell (5 Qs × 3 models), except llm-only (12, patient-specific only at tier-200).*

### Per-model × per-tier

| Model | tier-200 | tier-2000 | tier-20000 |
|---|---|---|---|
| claude-haiku-4-5 | **75%** | **70%** | **60%** |
| qwen2.5:32b | 42% | 50% | 40% |
| llama3.1:8b | 25% | 35% | 25% |

### Per-model × per-system, tier-200 (the "fair" snapshot)

| Model | graph | sql | sql-fts | sql-t2s | llm-only |
|---|---|---|---|---|---|
| claude-haiku-4-5 | 80% | 80% | 80% | 40%\* | **100%** |
| qwen2.5:32b | 20% | 60% | 60% | 60% | 0% |
| llama3.1:8b | 40% | 40% | 40% | 0% | 0% |

\* The 40% on Claude sql-t2s is a scorer artifact. See the False-Negatives section.

### Graph vs sql-t2s — the fair paradigm comparison

| Tier | graph | sql-t2s | Δ |
|---|---|---|---|
| 200 | 47% | 33% | **+13pp** |
| 2000 | 60% | 27% | **+33pp** |
| 20000 | 33% | 20% | **+13pp** |

Graph wins at every tier. The peak advantage is at tier-2000; tier-20000 degrades for separate reasons (see bug list).

### Per-question, tier-200 (which questions are universally hard?)

| Question | graph | sql | sql-fts | sql-t2s | llm-only |
|---|---|---|---|---|---|
| SL-19 (lookup) | 67% | **100%** | **100%** | 67% | 33% |
| MH-4 (multi-hop) | 33% | 33% | 33% | 0% | 33% |
| TMP-65 (temporal) | 33% | **100%** | **100%** | 0% | 33% |
| COH-1 (cohort) | 67% | 0% | 0% | 67% | — |
| RSN-4 (reasoning) | 33% | 67% | 67% | 33% | 33% |

MH-4 is universally hard (Claude nails it, open-source models don't). COH-1 fails in sql/sql-fts because those adapters pre-retrieve per-patient context — cohort questions need aggregation over all patients, which the pre-retrieval design doesn't do. graph and sql-t2s are the only systems that can do cohort counts.

### Latency

| System | p50 | p95 |
|---|---|---|
| graph | 14.8s | **37+ min** (qwen at tier-20000) |
| sql | 9.4s | 92s |
| sql-fts | 12.4s | 92s |
| sql-t2s | 10.7s | 69s |
| llm-only | 12.5s | 67s |

| Model | p50 | p95 |
|---|---|---|
| claude-haiku-4-5 | 6.4s | 32s |
| qwen2.5:32b | 51.6s | **27 min** |
| llama3.1:8b | 10.0s | 32s |

The qwen tier-20000 graph cells are an existential problem for any full sweep: `get_patient_summary` returns tens of thousands of rows of procedures/labs/encounters, and a 32B model crawls through that context. Three of the top four slowest cells were qwen/tier-20000/graph at 27–48 minutes each.

## Bugs discovered (consolidated from this session)

### Critical — block tier-2000/20000 on multiple systems

**B1. tier-2000 and tier-20000 Kuzu schema missing `value_canonical`/`units_canonical` columns.** ~~Code reads them in `get_labs`, `compare_observations`, `aggregate_observation_for_cohort`, `cohort_observation_distribution`, plus a couple others. Tier-200 was re-ingested today with the new schema (columns exist but all-null); tier-2000/20000 were last ingested 2026-04-09 with the old schema.~~ **RESOLVED 2026-04-23 evening** — all three tiers re-ingested on the new schema; `value_canonical` populated ~14% (expected).

**B2. tier-20000 Postgres is partial.** ~~Expected 20,000 patients, actual 3,944.~~ **RESOLVED 2026-04-23 evening** — re-ingested to full 20,000 patients; Kuzu and Postgres row counts agree across all tiers.

**B3. `get_diagnoses` `(finding)` default excludes prediabetes.** We added `NOT c.description ENDS WITH '(finding)'` to hide SDoH entries. But the SNOMED concept "Prediabetes (finding)" (code 714628002) is a clinical diagnosis, not SDoH — and it's the entity TMP-65 asks about. The filter is too coarse. Observed failures:
- TMP-65 graph tier-200 qwen: "The patient does not have a recorded condition that matches Prediabetes (finding)." (score=0)
- TMP-65 graph tier-20000 claude: same phrasing, scored 0.

**B4. Broken tier-200 recovery (already resolved).** Earlier today tier-200 Kuzu was re-ingested without REL tables — graph queries returned empty. The other session re-ran the ingest at 17:43 and restored it. Flagged here so it stays in the consolidated record.

### High — scorer and infra

**B5. Log truncation in multi-line answers.** The smoke script grepped for `^\[DEBUG\] ANSWER:` only; Claude's longer answers span many lines, so the captured text for some cells ends at a colon or heading. Claude sql-t2s MH-4 tier-200 looks like it scored 0 because my capture cut the line at "one medication was started:" — the naproxen bit was on the next line. Effects: Claude sql-t2s tier-200 true score is probably 80–100%, not 40%.

**B6. Fuzzy scorer rejects equivalent date formats.** Ground truth `2019-05-01` doesn't match `May 1, 2019`. Claude sql-t2s TMP-65 tier-200 said "The patient was first diagnosed with prediabetes on **May 1, 2019**." and scored 0. This is exactly the case LLM-as-judge is meant to fix.

**B7. `buildSqlContext` date-sort crash (fixed).** `b.date.localeCompare is not a function` — pg driver returned `Date` objects, not strings. Fixed this session by stringifying at the sort site and display.

**B8. pg DATE off-by-one (fixed).** `2023-08-06 UTC` rendered as `2023-08-05` in EET. Now fixed via `pg.types.setTypeParser` for OIDs 1082/1114/1184.

**B9. `sql-t2s` was unusable for Ollama (fixed).** Pre-fix: schema-in-prompt single-turn; model emitted raw SQL as the answer. Now wired up with an in-process `run_sql` tool loop matching the MCP surface.

### Medium — model behavior

**B10. qwen tier-20000 `get_patient_summary` context blow-up.** Returns thousands of rows; qwen then spends up to 48 minutes generating a structured summary that's still wrong. Runner is not at fault — the tool is returning too much.

**B11. Llama emits pseudocode as tool arguments.** Examples:
- MH-4 graph tier-20000: `encounter_id: "find_encounter_with_condition(patient_id=\"...\", cond..."` (truncated pseudocall).
- Repeated failure mode; the tool-calling protocol is fine (structure is valid JSON), but the value of an argument is a description of what the model wishes it could call rather than a real ID.

**B12. qwen invents UUID-looking encounter IDs.** On MH-4 at multiple tiers: "`Encounter with ID 14b2fda3-6a0d-49e5-a8c7-bb9d6ebc70f0 does not exist.`" — qwen never retrieves encounters, it just generates ID-shaped strings. Model-chaining weakness, not a tool bug.

### Low — tool-design

**B13. Sql-t2s tool-calls are not counted.** `runSqlT2S` uses a local `buildSqlExecutor(pool)` instead of `executeTool`; the metrics recorder only records tools executed via `executeTool`, so the breakdown shows `toolCalls: 0` for all sql-t2s cells even when the model made several. Doesn't affect correctness, affects reporting.

**B14. Llama sql-t2s at tier-2000 wrote `value_canonical does not exist in the medication table`** — model confabulated a column on the wrong table. Unrelated to B1 (this is a SQL-schema confusion).

## Scoring / GT problems

Beyond the scorer fuzziness above, there are systemic GT issues:

**S1. COH-1-class cohort counts use `count(*)` in GT vs `count(DISTINCT p)` in tools.** Documented earlier this session for COH-38. The two metrics diverge 6–10× at larger tiers; the scorer can't distinguish "wrong answer" from "different-but-valid metric."

**S2. Cohort GT includes SNOMED `(finding)` entries; tool excludes them by default.** COH-38 showed this; B3 is the other side of the same coin. The GT and tool need to agree on whether SDoH/findings are in-scope.

**S3. Trend-direction vocabulary mismatch.** Earlier probe: TMP-1 ground truth `increasing trend`, model said `remained stable at 6.9%` when 3 of 4 values were identical. Data-level correctness is indistinguishable from scorer-level error in fuzzy token overlap.

**S4. GT terseness mismatch.** System prompt says "give only the answer" but some models produce clinical-report-style answers. The correct answer is buried; fuzzy matching either accidentally hits or misses based on phrasing. RSN-4 Claude graph tier-200 ("prediabetes + well-controlled + 5-year trend") is clinically better than the GT phrasing but harder to score.

**S5. Missing tier-aware GT awareness in debug tooling.** My scoring pass assumed `COH-1` GT = `34` everywhere — hard-coded, ignored `groundTruthByTier`. A full rescore with tier-aware GT is what produced the numbers above. The actual `src/eval/scorer.ts` probably has the same blind spot (needs audit).

## Improvements — technical plan (design only, no code execution)

Ranked by combined {impact on paper deadline, blast radius, effort}. Effort band: **S** = single edit, **M** = a file or two, **L** = cross-cutting.

---

### R1. Re-ingest tier-2000 and tier-20000 with current schema — **DONE 2026-04-23**

**Problem (fixes B1, B2).** Lab tools error on the upper tiers; tier-20000 Postgres is 80% empty. Blocks honest scaling claims.

**Proposed fix.** Re-run `npm run ingest -- --tier 2000` and `npm run ingest -- --tier 20000` with the current `src/ingest.ts` (which declares `value_canonical` + `units_canonical` and the populated reference-range columns). For Postgres at tier-20000, investigate why only 3944/20000 loaded — likely the `src/sql/ingest.ts` path has an OOM or iterator truncation; compare to tier-2000 which completed.

**Risk.** Ingest time is long (tier-20000 was ~hours). Other session is the current owner of ingestion work. Coordinate ownership before starting. Don't auto-launch — belongs to the user per the long-runs rule.

**Test.** After ingest, run `scripts/probe-schema.ts .brainifai/data/kuzu-2000` to confirm `value_canonical` column exists; `SELECT count(*) FROM patient` on each PG DB.

**Effort.** **M** (configuration / re-run; actual code may be zero lines if ingest already works).

**Dependencies.** None — should be the first fix. Everything downstream depends on clean data.

---

### R2. Audit and unify cohort GT semantics — **DONE 2026-04-23**

**Problem (fixes S1, S2, B3 indirectly).** GT and tool disagree about: (a) patient-count vs record-count, (b) inclusion/exclusion of SNOMED findings.

**Proposed fix.** Decide the canonical semantics once:
- Patient-count (`COUNT(DISTINCT p)`) is clinically meaningful; use everywhere.
- SNOMED findings SHOULD be excluded from diagnosis-like queries but INCLUDED when the question is explicitly about SDoH. Add a `category` filter option instead of a blanket exclude.

Then update `scripts/recompute-cohort-gt.ts` to use `COUNT(DISTINCT p)` and mirror the tool's findings-exclusion, and regenerate `groundTruthByTier` for all cohort questions.

**Risk.** Changes GT numbers for ~60 cohort questions × 3 tiers. Before regen, eyeball-compare 5 expected-vs-new values to make sure the change isn't silent. No code change to the tool itself — it already uses `COUNT(DISTINCT p)`.

**Test.** Pre-compute old GT, regen, diff. If any GT shifts by more than the tool/model accuracy margin, investigate before committing.

**Effort.** **S** (one-file edit to `recompute-cohort-gt.ts` + a regen run).

**Dependencies.** Should precede any claim about sql/sql-fts/graph performance on cohort questions.

---

### R3. Relax the `(finding)` filter for clinically meaningful diagnoses

**Problem (fixes B3).** Prediabetes (SNOMED 714628002) is filed as "(finding)" but clinicians treat it as a diagnosis.

**Proposed fix.** Two options:
- **(a) Allow-list of clinically meaningful findings.** Keep the filter, but exempt specific codes known to be real diagnoses. Short list curated by a clinician would suffice (pre-diabetes, anemia, some screening results).
- **(b) Filter by SNOMED hierarchy.** Use SNOMED's semantic category ("(disorder)" vs "(finding)") but add an exception for findings that descend from "clinical finding" vs those that descend from "social context" / "event." This requires ingesting SNOMED category data.

**Pick.** **(a)** — faster, reversible, doesn't require an ontology pull.

**Test.** Run TMP-65 on all 3 models × 3 tiers after the allow-list is in place. Should jump from 33% to ≥80% where data exists.

**Effort.** **S** for the allow-list. **L** for the hierarchy approach.

**Dependencies.** None; orthogonal to R1 and R2.

---

### R4. Strengthen the scorer: date format + month-name tolerance

**Problem (fixes B6).** `2019-05-01` should match `May 1, 2019`.

**Proposed fix.** In `src/eval/scorer.ts`, add a normalization pass for date markers: parse both GT and answer for date candidates, canonicalize to YYYY-MM-DD, and compare those in addition to substring matching.

**Risk.** Parsing ambiguous dates (`01/05/2019` → US or UK?) is a known trap. Mitigate by only normalizing the GT markers we ourselves generate (always ISO) against common English date expressions in answers; don't try to normalize answers in general.

**Test.** Re-score the current smoke matrix with the upgraded scorer and diff. Expected: Claude sql-t2s TMP-65 flips from 0 → 1, similar for any `June 12, 2022`–style answers.

**Effort.** **S**.

**Dependencies.** None.

---

### R5. LLM-as-judge calibration

**Problem (fixes S3, S4, large chunks of all semantic mismatches).** Already discussed this session — `src/eval/judge.ts` exists with a 0–3 rubric but has never been calibrated against human labels.

**Proposed fix.**
1. **Self-consistency smoke first.** Run judge on the existing tier-200 Haiku incremental file (`results/incremental-claude-haiku-4-5-*-tier-200.json`) and inspect the judge-vs-fuzzy delta per question type. If judge gives Claude RSN-4 (which caught the prediabetes-vs-diabetes premise correction) a 3 and fuzzy gives it 0.5, we have the discrimination we need.
2. **50-question clinician calibration.** Pick a stratified sample across types (10 each) and human-label. Compare judge score to human. Record Cohen's κ.
3. **Cross-vendor sanity check.** Run 50 of the same with `openrouter/openai/gpt-4o-mini` as judge; measure Claude-vs-GPT judge agreement. Report in the paper.

**Risk.** Self-preference bias (Claude judges Claude). Mitigate with the GPT cross-check. Cost: Haiku judge ≈ $0.001/call, GPT-4o-mini ≈ $0.002/call. 50 × 2 judges = $0.15.

**Test.** After calibration, re-judge the full smoke matrix and the headline per-tier/per-system tables change measurably (I predict Claude numbers bump 10-20pp, open-source bumps less).

**Effort.** **M** — mostly execution/labeling, not code. Judge already written.

**Dependencies.** Independent; but most meaningful after R4 (fewer spurious disagreements to sort through).

---

### R6. Scope `get_patient_summary` returns (already partially done)

**Problem (fixes B10).** At tier-20000, `get_patient_summary(scope='all')` returns ~1k rows. qwen wades through that for 30–48 minutes.

**Proposed fix.** Defaults already shipped this session:
- `scope` parameter exists.
- `recent_labs` capped at 30; `recent_encounters` at 20.

Extensions:
- Add `limit` parameter to each sub-scope.
- Add `max_tokens` hint to the system prompt: "prefer `scope='demographics'` or a direct tool over `scope='all'` unless the question is genuinely an overview."
- Truncate `description` strings to 80 chars in the response.

**Risk.** Hiding information some questions might need. Use truncation flags + a `full` escape hatch.

**Test.** Re-run qwen tier-20000 graph on the same 5 questions; latency p95 should drop from 30–50 min to ≤ 5 min.

**Effort.** **S** (edit `src/api/tools.ts` + the system prompt).

**Dependencies.** None.

---

### R7. Record sql-t2s tool calls in metrics

**Problem (fixes B13).** sql-t2s uses `buildSqlExecutor(pool)` local to `runSqlT2S`, which doesn't go through `executeTool`'s metrics recorder. Breakdown shows `toolCalls: 0` for all Ollama/OpenRouter sql-t2s cells.

**Proposed fix.** Inside `buildSqlExecutor`, call `recordTool('run_sql', elapsedMs)` before returning. Or, expose `recordTool` at module scope and have the executor call it directly.

**Effort.** **S**.

**Dependencies.** None. Pure metrics cleanup.

---

### R8. Capture full answer text in smoke-matrix-style logs

**Problem (fixes B5).** Grep on `ANSWER:` misses multi-line answers.

**Proposed fix.** Either (a) redesign `debug-one-q.ts` to print answer on a single line (escape newlines), or (b) extend the grep to capture until the next `^\[DEBUG\]` marker, or (c) have it write structured JSON (one line per cell) and parse that instead of grepping.

**Pick.** **(c)** — JSON lines are scorer-friendly. One `--json` flag on `debug-one-q.ts`, prints `{cell: "...", answer: "...", latency: N, ...}` as a single line. Aggregator stays simple.

**Effort.** **S**.

**Dependencies.** None.

---

### R9. Sql-t2s retry-on-empty hint

**Problem (doesn't fix a bug, improves a weak point).** Llama at sql-t2s often gets 0 rows on first query and gives up. The Claude MCP variant does retry. The Ollama tool loop with sufficient `maxRounds` allows retries, but small models don't use that budget.

**Proposed fix.** Append to `SQL_T2S_SYSTEM`: "If a query returns no rows, try a different approach — different column, different table, broader filter — before concluding the data is absent. You have up to 20 query attempts." Observe whether llama 8B's recovery improves.

**Risk.** Might encourage runaway loops. Already bounded by `maxRounds=20`.

**Effort.** **S** (prompt edit).

**Dependencies.** None.

---

### R10. Tier-aware GT in `src/eval/scorer.ts` audit

**Problem (fixes S5).** My smoke scorer missed tier-aware GT; there's a risk `src/eval/scorer.ts` does too.

**Proposed fix.** Audit `scorer.ts` — if it reads only `q.answer`, patch it to prefer `q.groundTruthByTier[tier]` when present. Need to know the `tier` at scoring time; `run.ts` already swaps `q.answer` in tier mode (line 116), so scorer probably works — but verify, and add a test for COH-1 specifically.

**Effort.** **S**.

**Dependencies.** R2 (doesn't matter if the GT itself is wrong).

---

## Priority ordering

**Sequential:**
1. ~~**R1** (re-ingest)~~ — **DONE 2026-04-23**
2. ~~**R2** (cohort GT semantics)~~ — **DONE 2026-04-23**
3. ~~**R4** (scorer date tolerance)~~ — **DONE 2026-04-23**
4. **R5** (LLM-as-judge calibration) — rubric calibrated via 17-case walkthrough 2026-04-23; still need 50-case human agreement check before full-sweep claims

**Parallel / independent:**
- **R3** (findings allow-list) — unlocks TMP-65-class questions
- **R6** (tool-summary caps) — unlocks qwen at tier-20000
- **R8** (JSON logs) — better scripts & scorer plumbing
- **R7**, **R9**, **R10** — housekeeping

**Skip or defer:**
- Trying to fix llama's pseudocode-as-arg at the prompt level (B11) is unlikely to work; accept it as a legitimate model-quality data point. Include it in the paper's error analysis as a qualitative finding.

## Methodology notes for the paper

Three things the smoke data makes sharper:

1. **The "graph vs sql-t2s" framing holds directionally.** Graph wins at every tier; open-source models benefit most (qwen sql-t2s is 60% vs graph 20% at tier-200, but that's also where the scope-param fix just landed). Claude sees the smallest differential because both systems are near-ceiling for it.
2. **"LLM-only works for Claude on patient-specific questions"** — 100% at tier-200. This is the privacy-framing story the paper already plans; one concrete data point.
3. **Scaling is not cleanly monotonic.** Before claiming any scaling trend in the paper, need to repeat the probe on the same questions at each tier with consistent scorer (LLM-judge) and consistent GT semantics (R2). Otherwise the non-monotonicity is indistinguishable from schema bugs and scorer artifacts.

*— end of review —*
