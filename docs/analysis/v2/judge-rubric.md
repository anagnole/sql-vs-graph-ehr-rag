# Judge Calibration

**Purpose.** The authoritative scoring rubric for `src/eval/judge.ts`, plus a
growing adjudication log of specific cases the user + assistant have agreed on.
The prompt in §2 is loaded by the judge at evaluation time. §5 is an appendix
that informs future judge calls via few-shot examples once stable.

**Version.** v0 (2026-04-23) — initial draft. To be calibrated case-by-case.

**Ownership.** User is the clinical authority. Assistant drafts + surfaces
borderline cases. Rubric only changes after both parties agree.

---

## 1. Scoring scale (decided 2026-04-23)

Three-level graded, applied per individual answer:

| Score | Label | When to use |
|---|---|---|
| `1.0` | **Correct** | All key facts from the reference answer are present. Extra context, rephrasing, different date format, verbose clinical formatting are all fine. "Right answer present + extras that don't contradict" scores here. |
| `0.5` | **Partially correct** | (a) Key data present but the clinical assessment / trend word / direction is wrong (e.g. "remained stable" vs GT "increasing trend"); OR (b) some items in a list are right but not all; OR (c) answer wanders but right facts land. |
| `0.0` | **Wrong** | Hallucinated values, contradicts GT, or refuses to answer when an answer exists. Also: empty / unparsable responses, confident-but-wrong numerics. |

Plus two orthogonal boolean flags emitted alongside the score:

- `gt_suspect: true` — the judge believes the ground truth is wrong (e.g. GT uses a different semantic than the tool does: record-count vs. patient-count). Cell is flagged; it does **not** enter headline accuracy aggregates but is listed separately for clinician review.
- `over_answered: true` — the correct answer is present but padded with extra irrelevant or inaccurate content. Score still `1.0` (per "extras don't contradict" rule) but the flag feeds error analysis showing which models over-fetch.

## 2. Judge system prompt (authoritative copy)

Loaded verbatim by `src/eval/judge.ts` at runtime. **Keep this section
self-contained and parseable** — do not add project jargon without defining it.

> You are an expert clinical evaluator scoring an AI system's answer against a
> reference answer for an EHR question-answering benchmark.
>
> ## Scoring (0, 0.5, or 1):
>
> - **1 (Correct)**: The answer contains every key factual element in the
>   reference answer. Rephrasing, extra supporting context, different date
>   formats ("May 1, 2019" vs "2019-05-01"), verbose clinical formatting, or
>   units-clarifying additions are all acceptable. An answer that is
>   *strictly more informative* than the reference but remains factually
>   correct still scores 1.
>
> - **0.5 (Partially correct)**: The answer meets one or more of these:
>   - Key numeric values or entities are right, but the clinical assessment
>     (e.g. trend direction, severity category, control status) contradicts
>     or omits what the reference claims.
>   - For list answers: between 50% and 99% of reference items are correctly
>     named, or all are named but with a majority wrong on details.
>   - The answer eventually produces the correct information but wanders
>     through irrelevant or incorrect claims en route.
>
> - **0 (Wrong)**: The answer hallucinates data not supported by the record,
>   actively contradicts the reference, or claims the data cannot be found
>   when the reference supplies a concrete answer.
>
> ## Type-specific guidance:
>
> - **TEMPORAL TREND** questions: the trend direction (increasing /
>   decreasing / stable) is load-bearing. Correct direction + approximate
>   values = 1. Wrong direction but right values = 0.5. "Stable" when 3 of
>   4 readings are identical but the reference says "increasing" because
>   the earliest value was lower — this is 0.5 (facts present, synthesis
>   wrong).
>
> - **NUMERIC** questions: within 10% of the reference = 1. Within 25% = 0.5.
>   Worse = 0. Apply this only when the reference itself is an exact number;
>   if the reference describes a concept rather than a single value, use
>   the general rubric.
>
> - **LIST / SET** questions: count items matching the reference. >=80% of
>   items named correctly = 1. 50–79% = 0.5. <50% = 0. Handle "extras" by
>   whether they're presented as in-scope:
>   - Real entities from the record, presented as **context** ("…and
>     Naproxen is commonly paired with…") → score 1, `over_answered: true`.
>   - Real entities **claimed to answer the same question** (e.g. "Meds
>     started at that visit: Naproxen, Ibuprofen" when only Naproxen was
>     actually started there) → score **0.5**. The model added a wrong
>     claim inside the answer's scope; clinically this would mislead a
>     reader.
>   - Hallucinated entities (not in the record) → 0.
>
> - **REASONING / ASSESSMENT** questions: the clinical conclusion
>   (well-controlled vs moderately controlled, low vs moderate
>   cardiovascular risk, etc.) is the primary criterion. Supporting data
>   matters less if the conclusion is right. Answers that additionally
>   catch a premise error in the question (e.g. reference assumes diabetes
>   but patient has only prediabetes) AND then provide an assessment for
>   the corrected premise score 1 with an approving rationale — these are
>   preferred clinically.
>
>   **Premise-correction without assessment is NOT an upgrade.** If the
>   model catches the premise (e.g. "patient has only prediabetes, not
>   diabetes") but refuses to assess, it scores the same as any other
>   refusal-when-data-exists: **0**. A clinician receives zero actionable
>   information, identical to a model that didn't understand at all.
>
>   When the answer is a **summary with no explicit assessment**:
>   - If it includes clinical facts a clinician could use to reach the
>     right assessment themselves (condition list, vitals, labs, history
>     relevant to the question), score **0.5** — the model gave usable
>     raw material but skipped the synthesis.
>   - If the content is truly off-topic, fabricated, or about a different
>     patient than the reference implies, score **0**.
>
> - **UNANSWERABLE** questions: correctly refusing to answer = 1. Hedging
>   while refusing = 0.5. Attempting an answer with uncertainty = 0.5.
>   Confident wrong answer = 0.
>
> - **COHORT / AGGREGATION** questions: if your answer's number differs
>   from the reference by >25% AND the model's method looks
>   methodologically sound (e.g. it counted distinct patients where the
>   reference counted distinct records), set `gt_suspect: true` and
>   explain in the rationale. These cells are for clinician review.
>
> ## Flags (set independently of the score):
>
> - `gt_suspect`: true when you believe the reference answer is itself
>   wrong, inconsistent with the question's phrasing, or uses different
>   semantics than the model's method. Do NOT use this for "the model was
>   wrong" — use 0 or 0.5 for that.
> - `over_answered`: true when the key facts are present but buried in /
>   followed by substantial unrelated content (e.g. returning 5 medications
>   when 1 was asked for, producing a 500-token essay on clinical
>   complexity when the question was just "how many active problems").
>
> ## Response format (strict JSON, no markdown):
>
> ```json
> {
>   "score": 0 | 0.5 | 1,
>   "rationale": "<1–2 sentence explanation referencing the specific
>                 element of the answer that drove the score>",
>   "gt_suspect": <bool>,
>   "over_answered": <bool>
> }
> ```
>
> If the answer is empty or unparsable, score 0 with rationale "empty or
> unparsable" and both flags false.

## 3. Per-type check-lists (cheat sheet for the human adjudicator)

Use these when calibrating or disagreeing with the judge's score:

### simple-lookup
- Is the exact numeric value (within 10%) in the answer?
- Are the units right? Minor unit-case differences OK ("mg/dL" = "MG/DL").
- For date-bearing answers: accept any unambiguous format.
- If the question asks for "a value" and the model returns a list including the value, score 1 with `over_answered` if the extras are real, 0.5 if the extras are hallucinated.

### multi-hop
- Did the model chain correctly or get the right answer by luck?
- If the final answer is right, chain correctness doesn't affect the score — but note it in the rationale if the chain was visibly wrong (fed error analysis).
- Universal failure mode: models invent intermediate IDs (encounter_id, patient_id). If the model invented an ID and still somehow got the answer, that's a 1.0 lucky guess.

### temporal
- Trend word is load-bearing (see §2).
- Partial credit when 3 of 4 data points are present but one is missing.
- Date format is not load-bearing — "May 1, 2019" = "2019-05-01" = "1 May 2019".

### cohort
- Absolute numeric match within tolerance (10%).
- If the delta is >25% and the method is sound, `gt_suspect: true`.
- If the question asks "how many patients" and the answer gives "how many records", that's **0** (wrong metric), not `gt_suspect`, unless the GT itself is the record-count. This is a calibration trap — see Case #4 below.

### reasoning
- Clinical assessment is the primary criterion.
- Premise corrections (patient has prediabetes not diabetes) are a 1.0 *upgrade* if the downstream reasoning is then correct.
- Generic summaries that don't actually answer the question are 0.

### unanswerable
- Any clear refusal = 1.
- Any confident wrong answer = 0.
- Hedging is 0.5 only when the model explicitly says it can't confirm. "Probably X but it's not recorded" = 0.5; "X happened on 2020-01-01" when it didn't = 0.

## 4. Calibration protocol

To keep the judge anchored:

1. Every time the rubric changes (§2), write a brief "why" note in §6
   (changelog).
2. When a new edge case surfaces that isn't covered by the rubric, add it
   to §5 with the agreed score, the reason, and which type it belongs to.
3. Before a full sweep, re-judge the calibration set (§5 cases) and
   confirm the judge still scores them as agreed. If the judge drifts,
   the rubric or the prompt wording has to be adjusted.
4. The judge is NEVER told which model produced the answer (avoid
   model-identity bias).
5. Run at least two different judge models on a 50-case subset (e.g.
   `claude-haiku-4-5` + `openrouter/openai/gpt-4o-mini`) and report
   Cohen's κ. If κ < 0.7 the rubric is too subjective.

## 5. Adjudicated case log

Format: case id, question id + type, question text (trimmed), reference
answer, system answer, **agreed score + flags**, adjudication reason.

### Case #1 — `RSN-4` (reasoning) · qwen2.5:32b · graph · tier-200
- **Question**: How well-controlled is the patient's diabetes?
- **Reference**: Well-controlled. A1C values: 2022-04-13: 5.8%, ..., 2025-04-30: 6.3%. Most recent: 6.3%.
- **Answer**: "The most recent HbA1c value is 6.3%, indicating moderately controlled diabetes."
- **Agreed score**: `0.5` · `gt_suspect: false` · `over_answered: false`
- **Why**: Key datum (6.3%) correct; clinical assessment ("moderately") contradicts reference ("well-controlled"). Per §2 REASONING rule — clinical conclusion is primary; wrong conclusion with right data → partial. GT is defensible (6.3% < 7% ADA goal).

### Case #2 — `RSN-4` (reasoning) · claude-haiku-4-5 · graph · tier-200
- **Question**: How well-controlled is the patient's diabetes?
- **Reference**: same as Case #1.
- **Answer**: "The patient does not have diabetes; they have prediabetes (diagnosed 1993). Their glucose control is well-controlled and stable. Most recent HbA1c: 6.3% (April 2025). [5-year trend listed]. All values remain in the prediabetic range (5.7–6.4%)..."
- **Agreed score**: `1.0` · `gt_suspect: false` · `over_answered: false`
- **Why**: Per §2 REASONING rule — premise correction (prediabetes not diabetes) upgrades to 1.0 when the downstream assessment ("well-controlled") is correct and clinically stronger than the reference. GT is consistent; Claude didn't flag GT wrong, it reframed the question.

### Case #3 — `COH-38` (cohort) · qwen2.5:32b · graph · tier-2000
- **Question**: What are the 5 most common conditions among male patients?
- **Reference** (post-2026-04-23 regen): `Medication review due (situation) (966); Gingivitis (disorder) (799); Viral sinusitis (disorder) (633); Gingival disease (disorder) (459); Acute viral pharyngitis (disorder) (445)`
- **Answer**: "1. Medication review due - 966 patients, 2. Gingivitis - 799, 3. Viral sinusitis - 633, 4. Gingival disease - 459, 5. Acute viral pharyngitis - 445"
- **Agreed score**: `1.0` · `gt_suspect: false` · `over_answered: false`
- **Why**: All 5 items + counts match in correct order. SNOMED `(disorder)` suffix dropped in answer is cosmetic. Flagging for history: pre-regen this cell scored 0 against the record-count GT; today's R2 fix makes model + GT consistent.

### Case #4 — `TMP-1` (temporal) · qwen2.5:32b · graph · tier-2000
- **Question**: How has the patient's HbA1c trended over time?
- **Reference**: `increasing trend. Values: 2019-05-01: 5.8 %, 2022-02-16: 6.9 %, 2024-02-21: 6.9 %, 2026-02-25: 6.9 %`
- **Answer**: "The patient's HbA1c has remained stable at 6.9% from February 2022 to February 2026, except for a previous measurement of 5.8% in May 2019."
- **Agreed score**: `0.5` · `gt_suspect: false` · `over_answered: false`
- **Why**: All 4 values + dates present; synthesis wrong (reference says "increasing", model says "stable"). Per §2 TEMPORAL rule — data right, direction wrong → 0.5.

### Case #5 — `MH-4` (multi-hop) · qwen2.5:32b · graph · tier-200
- **Question**: What meds were started at the visit where the patient was diagnosed with hip osteoarthritis?
- **Reference**: `naproxen sodium 220 mg`
- **Answer**: "Naproxen sodium 220 MG Oral Tablet, Ibuprofen 400 MG Oral Tablet [Ibu]"
- **Agreed score**: `0.5` · `gt_suspect: false` · `over_answered: true`
- **Why**: The reference item is present, but Ibuprofen is **claimed as also started at that visit** when it wasn't — a wrong factual claim within the answer's scope. Not mere padding. Per §2 LIST rule (refined 2026-04-23 based on this case): real entities claimed as in-scope answers → 0.5.
- **Rubric change triggered**: §2 LIST rule split "extras as context" (1.0) from "extras as in-scope claim" (0.5).

### Case #6 — `MH-4` (multi-hop) · llama3.1:8b · graph · tier-20000
- **Question**: What meds were started at the visit where the patient was diagnosed with hip osteoarthritis?
- **Reference**: `naproxen sodium 220 mg`
- **Answer (literal text)**: `{"name": "get_encounter_detail", "parameters": {"encounter_id": "find_encounter_with_condition(patient_id=\"007ab53b-1293-c7a9-067d-f025ce9e3c87\", condition=...`
- **Agreed score**: `0.0` · `gt_suspect: false` · `over_answered: false`
- **Why**: Protocol failure — Llama emitted a pseudocode tool call as its final response text instead of calling the tool. No factual content; reference entity "naproxen" does not appear. Per §2 WRONG criterion: empty/unparsable-content fallback applies even though the text is syntactically parseable JSON.

### Case #7 — `SL-188` (simple-lookup) · qwen2.5:32b · graph · tier-200 (pre-R6 scope fix)
- **Question**: Give me this patient's demographics.
- **Reference**: `Born 2001-04-22, Gender: M, Race: white, Ethnicity: nonhispanic, Location: Taunton, Massachusetts`
- **Answer (trimmed)**: "The provided data represents a detailed medical and personal profile... Patient Information: Name: Tony (inferred); Gender: Male (inferred from encounter provider names); Age: ~23... [then SDoH sections, psychiatric conditions, etc.]"
- **Agreed score**: `0.5` · `gt_suspect: false` · `over_answered: true`
- **Why**: Core demographic facts are present in the essay, but the model also **claims to have inferred** info that was actually directly given (name, gender) and computes age wrong (2001-04-22 → ~25, not ~23). These are wrong claims within the answer's scope (demographics), so per the refined §2 LIST rule this is 0.5, not 1.0. `over_answered: true` because the essay drowns the answer in unrelated clinical content.

### Case #8 — `UNA-13` (unanswerable) · qwen2.5:32b · graph · tier-200
- **Question**: When was the patient diagnosed with HIV?
- **Reference**: `UNANSWERABLE: Patient has no record of HIV in their medical history.`
- **Answer**: "The patient does not have any recorded HIV diagnosis."
- **Agreed score**: `1.0` · `gt_suspect: false` · `over_answered: false`
- **Why**: Clear correct refusal. Per §2 UNANSWERABLE rule: "Any clear refusal = 1."

### Case #9 — `SL-19` (simple-lookup) · claude-haiku-4-5 · sql-t2s · tier-200
- **Question**: What was the patient's last total cholesterol?
- **Reference**: `145.3 mg/dL (recorded 2023-08-06)`
- **Answer**: "The patient's **last total cholesterol** was **145.3 mg/dL**, measured on **August 6, 2023**."
- **Agreed score**: `1.0` · `gt_suspect: false` · `over_answered: false`
- **Why**: Value + date present in different format. §2 SIMPLE-LOOKUP rule: "date format is not load-bearing." Markdown bold is cosmetic. Illustrates the R4 scorer gap the judge rubric already handles.

### Case #10 — `TMP-65` (temporal) · claude-haiku-4-5 · graph · tier-20000 (pre-R3 findings allow-list)
- **Question**: When did the patient first get a prediabetes diagnosis?
- **Reference**: `2019-05-01`
- **Answer**: "This patient does not have a prediabetes diagnosis on record. The patient has Type 2 Diabetes (diagnosed 2022-02-16), but no prediabetes diagnosis is present."
- **Agreed score**: `0.0` · `gt_suspect: false` · `over_answered: false`
- **Why**: Answer is factually wrong (prediabetes DOES exist as of 2019-05-01). Model's chain was sound given its tool output — but at the time, `get_diagnoses` filtered `(finding)` entries with no allow-list, so the tool silently dropped Prediabetes. Judge scores the patient-facing answer, not model intent; tool limitations that surface as wrong answers still score 0. The R3 findings allow-list landed later to prevent this.

### Case #11 — `COH-38` (cohort) · qwen2.5:32b · graph · tier-2000 · vs PRE-regen GT
- **Scenario**: hypothetical — what if we hadn't run the 2026-04-23 R2 GT regen? Judge encounters today's model answer vs yesterday's stale GT.
- **Question**: What are the 5 most common conditions among male patients?
- **Reference (stale, pre-regen)**: `Medication review due (situation) (6398); Stress (finding) (2521); Gingivitis (disorder) (2508); Full-time employment (finding) (2325); Part-time employment (finding) (1449)`
- **Answer**: `Medication review due (situation) (966); Gingivitis (disorder) (799); Viral sinusitis (disorder) (633); Gingival disease (disorder) (459); Acute viral pharyngitis (disorder) (445)`
- **Agreed score**: `1.0` · `gt_suspect: true` · `over_answered: false`
- **Why**: Model used `count(DISTINCT p)` + findings excluded — methodologically sound clinical aggregation. Stale GT used `count(*)` + findings included — different question entirely. Per §2 COHORT rule: "if your answer's number differs from the reference by >25% AND the model's method looks methodologically sound... set `gt_suspect: true`." The 6× delta on every row is the signature. Illustrates the GT-fix that R2 performed.

### Case #12 — `RSN-101` (reasoning) · qwen2.5:32b · graph · tier-200
- **Question**: How clinically complex is this patient?
- **Reference**: `Moderate clinical complexity. 3 active conditions: Chronic sinusitis; Essential hypertension; Prediabetes.`
- **Answer (trimmed)**: Long essay covering substance use disorders, psychiatric history, vaccinations, visit summaries — but **never explicitly rates complexity** as low/moderate/high.
- **Agreed score**: `0.5` · `gt_suspect: false` · `over_answered: true`
- **Why**: No clinical assessment given, but the essay contains real clinical facts from the patient's record that a clinician could use to derive the assessment themselves. Per §2 REASONING subrule (added 2026-04-23 after this case): "summary with no explicit assessment + usable raw material → 0.5". `over_answered: true` because the essay sprawls. Note: the conditions listed differ from GT's expected three; but because the judge can't cross-verify which patient's chart the model actually retrieved, and because the content is still clinically real (not fabricated), we credit the partial.
- **Rubric change triggered**: §2 REASONING split "no assessment but relevant facts" (0.5) from "no assessment and off-topic" (0.0).

### Case #13 — `COH-14` (cohort) · claude-haiku-4-5 · graph · tier-200 — numeric within 10%
- **Question**: What is the average most-recent Total Cholesterol value for patients with Hyperlipidemia?
- **Reference (post-regen)**: `189.03 (across 22 patients)`
- **Answer**: "The average most-recent Total Cholesterol value for patients with Hyperlipidemia is 184.07 mg/dL."
- **Agreed score**: `1.0` · `gt_suspect: false` · `over_answered: false`
- **Why**: 184.07 vs 189.03 → 2.6% relative error, well within the 10% band. The `(across 22 patients)` metadata in GT is secondary — it's post-regen context, not a scored claim. Cohort-size differences at the boundary (21 vs 22 patients) can explain the 2.6% delta without gt_suspect being warranted.

### Case #14 — `COH-14` (hypothetical) — numeric within 25%
- **Question + reference**: same as Case #13.
- **Hypothetical answer**: "The average Total Cholesterol for patients with Hyperlipidemia is approximately 165 mg/dL."
- **Agreed score**: `0.5` · `gt_suspect: false` · `over_answered: false`
- **Why**: 165 vs 189.03 → 12.7% relative error. Per §2 NUMERIC band: within 10% = 1.0, within 25% = 0.5. Hedging word "approximately" doesn't change the score — it's still a concrete value being asserted.
- **Marker for future**: holds the 10–25% band anchor. Future judge calibration runs should score this synthetic example as 0.5.

### Case #15 — `MH-4` (hypothetical) — correct answer + pure-context extras
- **Question + reference**: same as Case #5 (naproxen sodium 220 mg).
- **Hypothetical answer**: "Naproxen sodium 220 MG Oral Tablet was started at the visit. Naproxen is a nonsteroidal anti-inflammatory commonly used for osteoarthritis pain management and reduces inflammation via COX inhibition."
- **Agreed score**: `1.0` · `gt_suspect: false` · `over_answered: true`
- **Why**: Reference item present; extras are pharmacology context, NOT additional in-scope drug claims. Distinguishes from Case #5 (where the extra med "Ibuprofen" was claimed as also-started-at-that-visit). Per §2 LIST rule: "real entities… presented as context → score 1, over_answered: true." This case nails down the flag-without-penalty regime.

### Case #16 — `RSN-4` (reasoning) · llama3.1:8b · graph · tier-200 — premise-catch without assessment
- **Question**: How well-controlled is the patient's diabetes?
- **Reference**: `Well-controlled. A1C values: 2022-04-13: 5.8%, 2023-04-19: 6.1%, 2024-04-24: 6.2%, 2024-12-11: 6.2%, 2025-04-30: 6.3%. Most recent: 6.3%.`
- **Answer**: "The patient's diabetes control is not assessable from the provided information, as only prediabetes is mentioned in their medical history."
- **Agreed score**: `0.0` · `gt_suspect: false` · `over_answered: false`
- **Why**: Llama correctly identifies that the question's premise is wrong (patient has prediabetes not diabetes) — this is the same premise-catch pattern as Case #2 (Claude). **But unlike Case #2, Llama refuses to assess**: no A1C data shown, no "well-controlled for prediabetes" synthesis. Per the refined §2 REASONING subrule: premise correction is NOT an upgrade without a downstream assessment. Clinically, "not assessable" delivers zero actionable info — same as any refusal-when-data-exists (score 0).
- **Rubric change triggered**: §2 REASONING now explicitly states that premise-catch without assessment equals a refusal (0).
- **Probe provenance**: flagged by the judge-subagent probe on 2026-04-23. Initial human adjudication leaned 0.5 (credit for catching premise); subagent argued 0.0 citing §2 WRONG criterion; the human sided with the subagent and refined the rubric.

### Case #17 — Judge-subagent probe results (2026-04-23, self-test)
- **Context**: 5 cells from `/tmp/smoke-cells.json` (not previously in the calibration log) dispatched to 5 parallel Agent subagents, each given this document as rubric input.
- **Results**: 4/5 scores matched the human's initial read; 1 disagreement (Case #16) was adjudicated in favor of the subagent and drove the REASONING rubric refinement above.
- **Additional signal**: one subagent flagged `over_answered: true` on an SL-19 answer that listed 3 cholesterol values when 1 was asked for — a flag the human had missed. Treated as tighter (not contradictory) rubric application; no rubric change needed.
- **Conclusion**: rubric is usable as a judge prompt. Expected disagreement rate with human judgment on borderline cases: ~15–20% per this probe; lower on unambiguous cases. Run a 50-sample human-judge agreement check before declaring the rubric calibrated for paper-facing claims.

## 6. Changelog

- **2026-04-23 v0** — Initial draft. Scoring scale decided: 3-level graded
  (0, 0.5, 1) plus `gt_suspect` + `over_answered` flags. Rubric built on
  EHRNoteQA's 0–3 scale collapsed to 3 levels. Type-specific guidance
  drawn from the 2026-04-23 smoke matrix failure patterns. Calibration
  log empty — first walkthrough pending.
- **2026-04-23 v0.1** — LIST rule refined. Case #5 (MH-4 with correct med
  + an off-scope med claimed as also-in-scope) surfaced the gap. Added
  the distinction between "extras as context" (1.0) and "extras as
  in-scope claim" (0.5). First 6 cases adjudicated.
- **2026-04-23 v0.2** — REASONING rule split. Case #12 (RSN-101 essay
  with relevant clinical facts but no complexity rating) surfaced the
  gap. "Summary with no explicit assessment + usable raw material" now
  scores 0.5; "no assessment and off-topic" stays 0. Cases #7–12 added.
- **2026-04-23 v0.3** — REASONING rule tightened. Subagent probe (Case
  #16) surfaced premise-catch-without-assessment case. Premise correction
  upgrades to 1 only when the model then provides the corrected
  assessment; refusing after catching the premise still scores 0. Cases
  #13–16 added. Probe itself logged as Case #17.
