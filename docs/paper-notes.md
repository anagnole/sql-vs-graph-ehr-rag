# Paper Notes — things to mention when writing

A running list of session-derived findings, methodology decisions, and error-analysis material that should make it into the Future Internet paper. Organised by the section each bit most likely belongs in. Not yet written prose — raw notes.

Last updated: 2026-04-23.

---

## Methods — Evaluation

### Question bank
- **334 as of 2026-04-23** (simple-lookup 72, multi-hop 58, temporal 56, cohort 60, reasoning 60, unanswerable 28). Negation category (20 planned in paper scope) not yet generated. Anchored to first-200 alive patients from Synthea seed 42.
- Cohort questions carry a `groundTruthByTier` field — three numeric answers per question, one per tier (200 / 2000 / 20000). Regenerated 2026-04-23 with `scripts/recompute-cohort-gt.ts`.
- **Cohort GT semantics (2026-04-23 correction).** Earlier GT used `count(*)` (record count) and included SNOMED `(finding)` entries in diagnosis-rank questions. Tools use `count(DISTINCT p)` (patient count) and exclude findings by default with a clinical-findings allow-list. GT regenerated to match. Numbers shifted by ~6–10× on gender/age top-5 questions; ~30 cohort questions changed.
- A small clinical-findings allow-list lets real diagnoses like "Prediabetes (finding)" through the SDoH filter. List lives in `src/api/tools.ts` `CLINICAL_FINDINGS_ALLOWLIST`, mirrored to Brainifai.

### Systems compared
- **graph** — KG + MCP (Claude) or in-process tool-calling (Ollama/OpenRouter) against Kuzu. This is the thesis-primary system.
- **sql-t2s** — text-to-SQL via `run_sql` tool; Claude uses MCP, open-source models use native tool-calling against the same SELECT-only executor. Same agentic shape as graph — this is the **fair paradigm comparison** per the Future Internet plan.
- **sql** / **sql-fts** — retrieval-augmented baselines. Pre-retrieve structured patient context, inject into prompt, single-turn completion. NOT agentic. Different question than graph-vs-sql-t2s.
- **llm-only** — full patient bundle in context, no retrieval. Tier-200 patient-specific questions only (context blows at higher tiers).

Mention both graph-vs-sql-t2s (paradigm) and graph-vs-sql-fts (vs non-agentic baseline) — they answer distinct questions.

### Models
- Closed-frontier: Claude Haiku 4.5 (claude-haiku-4-5-20251001).
- Open (large): Qwen 2.5 32B, via Ollama (local, 48 GB M4 Mac).
- Open (small): Llama 3.1 8B, via Ollama.
- OpenRouter wiring also in place for hosted open-source variants (Qwen 72B, Llama 3.3 70B, DeepSeek); not run yet.

### Scoring
- **Automated fuzzy scorer** (`src/eval/scorer.ts`): F1 for list answers, numeric tolerance (10% → 1, 25% → 0.5) for cohort/numeric, token-overlap fuzzy for everything else. Whitespace collapse between numbers and units. Date-format normalization ("May 1, 2019" ↔ "2019-05-01"). Unanswerable + negation have polarity-aware logic.
- **LLM-as-judge** (`src/eval/judge.ts`): 3-level graded (0 / 0.5 / 1) with `gt_suspect` + `over_answered` flags. Authoritative rubric in `docs/judge-calibration.md` §2, loaded at import time. Calibrated through 17 adjudicated cases on 2026-04-23; rubric refined twice during calibration (LIST and REASONING rules split).
- **Report strict vs lenient bounds.** Strict = treat 0.5 as 0 (matches FHIR-AgentBench binary). Lenient = treat 0.5 as 1. Both come from the same judge scores; gap is an intrinsic uncertainty bound.
- **`gt_suspect` cells excluded from headline accuracy**; reported separately as "GT-review needed".

### Methodology caveats to list honestly
- Judge is not yet calibrated against human labels (pending 50-case set).
- Self-preference bias when judge is Claude and systems include Claude-CLI cells. Mitigation plan: cross-vendor judge via `openrouter/openai/gpt-4o-mini` on a 50-case subset, report inter-judge κ.
- Smoke matrix fuzzy scores were biased low by: date-format mismatch (fixed in scorer R4), KUZU_DB_PATH bug (fixed), log-truncation in the smoke script (fixed). Headline fuzzy numbers from 2026-04-23 are lower than ground-truth accuracy.

---

## Results — qualitative findings

### OSS-models over-answer (primary error pattern)
- Qwen 32B returns supersets on multi-hop (e.g. MH-4: "Naproxen sodium 220 MG, Ibuprofen 400 MG" when only naproxen was in-scope). The correct answer is always in the response; the question is whether the extras are presented as in-scope claims (0.5 under our rubric) or contextual padding (1.0 + `over_answered: true` flag).
- Claude does the proper multi-hop chain (find encounter → filter meds by encounter); Qwen takes the "get all meds" shortcut.
- Report the `over_answered` flag prevalence per model — it's a meaningful axis for clinical practice even when correctness is the same.

### Clinical reasoning delta (biggest model-quality axis)
- On RSN-4 ("how well-controlled is the patient's diabetes?"), Claude caught that the patient has prediabetes not diabetes, cited ADA thresholds (5.7–6.4 prediabetic, ≥6.5 diabetic), and gave a scoped "well-controlled in prediabetic range" answer with the 5-year trend. Qwen said "moderately controlled" (wrong assessment at 6.3%); Llama said "not assessable" (caught the premise but refused to synthesize).
- This is a qualitative finding about frontier vs OSS reasoning that the paper should surface, not just quantify.

### Tool-call reliability at the 8B boundary
- Llama 3.1 8B emits pseudocode-as-tool-argument on multi-hop: `encounter_id: "find_encounter_with_condition(patient_id=\"007ab...\")"` — the literal string, not a call. The tool-calling protocol is intact (structurally valid JSON); the semantic content is wrong.
- Also observed: Llama abandons `run_sql` after 0 rows. "Unfortunately, the query returned no rows. Let's try a different approach." — then stops. Prompt mitigation added to `SQL_T2S_SYSTEM` but didn't fully eliminate the behavior.
- Worth a note in the discussion: self-hostable OSS below the ~30B boundary has a tool-calling reliability floor that affects multi-hop correctness more than single-shot retrieval.

### Kitchen-sink pattern
- Pre-fix, Qwen defaulted to `get_patient_summary(scope='all')` for any patient-specific question — even "give me demographics". It then wrote 1000-token structured essays. The `scope` parameter (added 2026-04-23) short-circuited to a single section for narrow questions; tier-20000 latency dropped from ~80s to ~13s for the same question.
- This isn't just a perf note — it's a tool-design principle: give the model narrow tools and tell it not to kitchen-sink. Relevant to anyone building an agentic clinical QA system.

### Scorer / GT mismatches
- Fuzzy scorer underestimates accuracy on:
  - Date-format variants ("May 1, 2019" vs "2019-05-01")
  - Verbose correct answers with markdown / bullet formatting
  - Trend-word paraphrases ("steady" vs "stable")
- Judge rubric handles all three. Paper should report both fuzzy and judge scores for the hardest types (reasoning, temporal) so the delta is visible.

---

## Discussion — implications

### The "self-hostable EHR assistant" claim
- Single data point we're pursuing: Qwen 2.5 32B on local Ollama reaches {X}% on tier-200 graph — within {Y} points of Haiku. At 32B the GPU + RAM requirements are already meaningful but fit on commodity hardware (48 GB Apple Silicon here). This is the concrete deployability data the privacy-framing subsection needs.
- Llama 8B is too small to be a paradigm-comparable model — it has a tool-reliability floor. Mention it as a negative result for "how small can we go".

### Graph-vs-sql-t2s paradigm direction
- In the 5-question smoke at tier-200/2000/20000, graph beat sql-t2s by +13pp / +33pp / +13pp (tier-aware GT, fuzzy scorer). Directional but not load-bearing (n too small, scorer biased).
- Graph's advantage is largest at tier-2000 in our data — noise? Real? Can't tell yet. The paper's "does the advantage grow with scale" claim is the one that needs the full sweep to be defensible.

### Cohort aggregation semantics matter
- COH-38 gender/top-5 question produces different answers under `count(*)` (record count) vs `count(DISTINCT p)` (patient count). The model's answer is clinically correct under either metric; the GT choice determines correctness. This is the kind of thing clinicians-as-judges notice immediately; auto-scorers don't. It's one concrete example where judge + `gt_suspect` flag pays off.

### Date handling as a trap
- pg's default DATE → JS Date conversion silently shifts dates by a timezone boundary. For EHR benchmarks where the ground truth is day-precision, this adds a whole-class-of-cells false-negative rate. Sophisticated benchmarks should assume it's happening. We fixed it with `pg.types.setTypeParser` on OIDs 1082/1114/1184.

---

## Reproducibility statement (artifact release)

What we plan to release:
- **Question bank** — `data/generated/evaluation-questions-tiered.json` (tiered, 348 Qs target).
- **Tier DBs** — Kuzu + Postgres snapshots for 200 / 2000 / 20000. Or regeneration scripts from the Synthea seed-42 snapshot.
- **Tool surface** — `src/api/tools.ts` (ThesisBrainifai in-process) and the mirror in `Brainifai/src/graphstore/kuzu/ehr-adapter.ts` (MCP). Both now document the findings allow-list and the scope param.
- **Eval harness** — `src/eval/runner.ts`, `src/eval/judge.ts`, `src/eval/scorer.ts`.
- **Judge rubric** — `docs/judge-calibration.md` — authoritative prompt + full adjudicated case log. Paper should cite this as methodology.
- **Docker-compose** for Postgres + Ollama.

What we can't / won't release:
- Synthea CSV snapshot regeneration is not deterministic at seed=42 (produces 23,040 vs 23,097 patients). Ship the snapshot, not the regen script.
- OpenRouter-routed runs are dependent on an external service; reproduction requires a separate API key.

---

## Footnotes worth writing

1. **Date-format scorer bias**: older benchmarks (emrQA, EHRSQL) use regex matching on ISO dates. On open-source models that prefer "May 1, 2019", this gives false-negatives. Our scorer normalizes ("May 1, 2019" → "2019-05-01") before matching; a binary scorer without this normalization would report ~X points lower on our temporal questions.
2. **Why 3-level graded instead of FHIR-AgentBench binary**: our REASONING and TEMPORAL cases hinge on "data right, synthesis wrong" or "correct answer + wrong extra claim", which binary throws away. We report both strict (0.5 → 0) and lenient (0.5 → 1) to give FHIR-AgentBench-comparable bounds.
3. **Why keep the `over_answered` flag**: reviewers will ask about hallucination rate. `over_answered` is a weaker failure than hallucination (extras are real patient-record entities, not fabricated) — but it's misleading for clinical practice. Reporting it separately distinguishes "OSS doesn't know" from "OSS over-fetches".
4. **Why not Cypher generation as a fourth system**: deferred to future work; the May 30 deadline doesn't fit a fair Cypher-generation implementation.

---

## Things NOT to claim in the paper (traps to avoid)

- **Don't claim the graph advantage is load-bearing** from the 5-question smoke — it's directional, not statistical. Wait for the full sweep with McNemar CI.
- **Don't claim llama 8B is unfit for EHR tasks** — it's fit for single-tool questions (SL-19 + COH-14 both tied Qwen at tier-200). It's unfit for multi-hop chaining, which is a narrower claim.
- **Don't claim our judge is human-calibrated** until we've done the 50-case labeling.
- **Don't claim KG + MCP is novel at the tooling layer** — graph-RAG for clinical QA has precedents (GraphCare, DR.KNOWS, FHIR-AgentBench). Novelty is the scaling axis, not the tools.
- **Don't overclaim privacy**: running Qwen 32B locally doesn't solve clinic-grade compliance; it just lets you avoid sending PHI to a cloud LLM. Keep the framing narrow.

---

## Open issues to revisit before drafting

- Check whether "within-10% / within-25%" tolerance bands are standard for clinical QA benchmarks or whether we're inventing that.
- Whether the `gt_suspect` mechanism needs a formal audit trail in the dataset we release (probably yes — reviewers will want to know how many cells were excluded).
- Decide if we should include Llama 8B in the headline tables or only as a footnote about the tool-reliability floor.
- Confirm whether we want to ship the full 17-case adjudication log in the paper supplementary, or just the rubric + agreement numbers.
