# Ingest Runbook — tier-2000 & tier-20000

> **STATUS (2026-04-23 end of day)**: this runbook was written while the
> tier-2000 / tier-20000 re-ingest was still pending. **By end of session,
> all three tiers were re-ingested** (Kuzu + Postgres) and the cohort GT
> regenerated. Row counts: 200 / 2000 / 20000 patients per tier, Kuzu and
> Postgres in agreement; `value_canonical` populated ~14% (expected — only
> LOINC-mapped labs get canonicalized). **Do NOT re-run ingest just
> because this doc exists.** Check `scripts/probe-schema.ts` and
> `scripts/check-canonical.ts` to verify state before doing anything.
> This runbook is kept for the next schema change.

**Purpose** (historical, pre-2026-04-23-evening). After the 2026-04-23 schema update (`value_canonical`, `units_canonical`, reference-range columns on `HAS_RESULT`), tier-2000 and tier-20000 Kuzu DBs were stale. `get_labs`, `compare_observations`, `aggregate_observation_for_cohort`, and `cohort_observation_distribution` all errored on the old schema with *Binder exception: Cannot find property value_canonical for r*. Tier-200 was already re-ingested by a parallel session.

This runbook documents what to run, in what order, and how to verify success. **Do not execute this autonomously** — follow `feedback_long_runs.md`: print the command, let the user run it in their own terminal.

## Pre-flight

1. Confirm which tiers actually need work. Shouldn't trust timestamps — probe the schema:
   ```bash
   npx tsx scripts/probe-schema.ts .brainifai/data/kuzu-200    # expect value_canonical column
   npx tsx scripts/probe-schema.ts .brainifai/data/kuzu-2000   # probably missing
   npx tsx scripts/probe-schema.ts .brainifai/data/kuzu-20000  # probably missing
   ```
   A clean result includes `Does value_canonical column exist? YES`. A stale DB says `NO — Binder exception ...`.

2. Confirm the source snapshot is still on disk:
   ```bash
   ls -la data/generated/patients.json data/generated/tier-2000.json data/generated/tier-20000.json
   ```
   All three should exist. `patients.json` is ~7.3 GB; the two tier-allowlists are small JSON files. If missing, see memory `project_future_internet_paper.md` "Data state" section — Postgres ehrdb-20000 is the authoritative recovery source but would need a re-export step.

3. Check who's touching the files. `pgrep -f 'tsx src/ingest.ts'` and `lsof .brainifai/data/kuzu-2000` should both return nothing before starting.

4. Note: Synthea CSV regeneration is **not** deterministic at seed=42 (memory: produces 23,040 vs. 23,097 patients). Always ingest from the snapshot, not from regenerated CSVs.

## Re-ingest sequence (Kuzu)

Run in this order — smallest → largest. Each rewrites `.brainifai/data/kuzu-<N>` in place. Expected wall-time ballpark based on prior runs (tier-2000 ~minutes, tier-20000 > 1 hour). No dollar cost — ingest is local-only.

```bash
# 1. tier-2000
NODE_OPTIONS=--max-old-space-size=16384 \
  npm run ingest -- --tier 2000

# 2. tier-20000 (memory note: Node heap needs headroom for this one)
NODE_OPTIONS=--max-old-space-size=16384 \
  npm run ingest -- --tier 20000
```

Per memory, tier-200 was last re-ingested today at 17:43 — confirm via `stat -f "%Sm" .brainifai/data/kuzu-200`. If the value is older than the latest schema change in `src/ingest.ts`, tier-200 needs rerun too.

## Verify after each ingest

```bash
# 1. Schema — expect value_canonical, units_canonical, normal_low/high, critical_low/high
npx tsx scripts/probe-schema.ts .brainifai/data/kuzu-<N>

# 2. End-to-end smoke on one lab question — expect non-empty get_labs result
OLLAMA_DEBUG=1 npx tsx scripts/debug-one-q.ts SL-19 qwen2.5:32b <N> graph --json \
  | jq '{answer, toolCalls, kuzuMs, latencyMs}'
```

`answer` should contain the tier's patient cholesterol value; `kuzuMs` should be non-zero (0 means the tool short-circuited, usually an error).

## Postgres — tier-20000 partial-ingest bug

Separate from the Kuzu issue: `ehrdb-20000` holds only 3,944 of 20,000 patients. Root cause not yet traced. Steps to investigate **before** re-ingesting (re-ingesting without the fix will re-create the same partial state):

1. Inspect `src/sql/ingest.ts` for iterator truncation / async backpressure bugs that would only bite on the large snapshot. Tier-2000 completed, so whatever breaks the flow triggers between 2k and 20k records.
2. Check `docker exec thesis_ehr_pg psql -U user -d ehrdb-20000 -c "SELECT count(*) FROM observation"` — if observations are ~proportional to patients (i.e. also ~20%) the ingest cut off mid-run. If observations are complete but patients aren't, there's a per-table failure.
3. Once root cause is identified and fixed in `src/sql/ingest.ts`:
   ```bash
   # Drop the partial DB; re-ingest fresh
   docker exec thesis_ehr_pg psql -U user -c 'DROP DATABASE "ehrdb-20000"'
   docker exec thesis_ehr_pg psql -U user -c 'CREATE DATABASE "ehrdb-20000"'
   NODE_OPTIONS=--max-old-space-size=16384 npm run sql-ingest -- --tier 20000
   ```
   (The exact `npm run` target name may differ — check `package.json`. Memory doesn't specify it.)

## Post-ingest re-generate cohort GT

Now that R2 (patient-count + findings allow-list) landed in `scripts/recompute-cohort-gt.ts`, every cohort question needs regenerated `groundTruthByTier` to match the updated tool semantics. Run only after **both** tier-2000 and tier-20000 Kuzu are clean:

```bash
npx tsx scripts/recompute-cohort-gt.ts
```

This overwrites `data/generated/evaluation-questions-tiered.json` in place. Diff against the previous copy before committing:

```bash
git diff data/generated/evaluation-questions-tiered.json | grep '^[+-]' | head -40
```

Expect ~60 cohort questions × 3 tiers to shift. Sanity-check a handful:
- "How many patients have both Diabetes and Hypertension?" — tier-2000 should stay at 307-ish (this one is already patient-count), tier-20000 stays at 3042.
- "What are the 5 most common conditions among male patients?" — big drop in numbers compared to old GT (6398 → ~966 at tier-2000). That's the intended change.

## After all of the above

- `git status` — expect `.brainifai/data/kuzu-*` modified, `data/generated/evaluation-questions-tiered.json` modified. Don't commit the Kuzu files (they're large binaries; see if `.gitignore` already excludes them — memory suggests yes).
- Re-run the smoke matrix (`docs/smoke-matrix-review-2026-04-23.md` has the command shape).
- Update memory `project_eval_infrastructure.md` with the new "last ingested" timestamps.

## Things NOT to do

- Don't delete `data/generated/patients.json` — it's the canonical snapshot.
- Don't regenerate Synthea at seed=42 expecting reproducibility — it isn't (memory).
- Don't run the Brainifai ingest script on these DBs; it uses a different schema (no `value_canonical`).
- Don't run `ollama pull` or any LLM calls from inside an ingest session — separate concerns.
