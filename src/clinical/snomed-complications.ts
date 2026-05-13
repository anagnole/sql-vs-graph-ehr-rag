/**
 * Curated SNOMED-CT child → parent edges for the COMPLICATION_OF relationship.
 *
 * Scope: limited to concepts that actually appear in the Synthea-generated
 * cohort and have unambiguous SNOMED-CT "due to" / hierarchical parents. We
 * deliberately do NOT try to ship the full SNOMED-CT `is_a` hierarchy — that's
 * a licensed resource and would dwarf the rest of the graph.
 *
 * Replaces the prior word-overlap heuristic at `src/ingest.ts` (removed). Edges
 * here are hand-verified from the ingested concept_conditions table.
 *
 * Adding a new entry: confirm (a) the child code appears in the Synthea cohort,
 * (b) the SNOMED-CT hierarchy or disease-causation relation supports it,
 * (c) the parent code is also in the cohort (orphans are dropped at edge
 * generation time).
 */

export interface ComplicationEdge {
  childCode: string;
  parentCode: string;
  /** Free-text rationale — shown in audit logs / paper appendix. */
  rationale: string;
}

export const COMPLICATION_EDGES: ComplicationEdge[] = [
  // Diabetes (T2DM) and its direct microvascular/macrovascular complications.
  // Parent: 44054006 Diabetes mellitus type 2 (disorder)
  {
    childCode: "368581000119106",
    parentCode: "44054006",
    rationale: "Neuropathy due to T2DM — explicit 'due to' in SNOMED preferred term",
  },
  {
    childCode: "1551000119108",
    parentCode: "44054006",
    rationale: "Nonproliferative diabetic retinopathy due to T2DM — explicit 'due to'",
  },
  {
    childCode: "127013003",
    parentCode: "44054006",
    rationale: "Disorder of kidney due to diabetes mellitus — explicit 'due to'",
  },
  {
    childCode: "90781000119102",
    parentCode: "44054006",
    rationale: "Microalbuminuria due to T2DM — explicit 'due to'",
  },
  {
    childCode: "157141000119108",
    parentCode: "44054006",
    rationale: "Proteinuria due to T2DM — explicit 'due to'",
  },
  {
    childCode: "80394007",
    parentCode: "44054006",
    rationale: "Hyperglycemia — diabetes is the overwhelmingly common cause in this cohort",
  },

  // CKD staging progression. SNOMED treats stage N as a child of generic CKD
  // via is_a; we encode the "progression" ordering as complication edges so
  // the UI can show stage 4 → stage 3 → stage 2 → stage 1 causality.
  {
    childCode: "431856006",
    parentCode: "431855005",
    rationale: "CKD stage 2 progresses from stage 1",
  },
  {
    childCode: "433144002",
    parentCode: "431856006",
    rationale: "CKD stage 3 progresses from stage 2",
  },
  {
    childCode: "431857002",
    parentCode: "433144002",
    rationale: "CKD stage 4 progresses from stage 3",
  },
  {
    childCode: "46177005",
    parentCode: "431857002",
    rationale: "End-stage renal disease follows CKD stage 4",
  },

  // CKD driven by diabetes.
  {
    childCode: "431855005",
    parentCode: "127013003",
    rationale: "CKD stage 1 in diabetic nephropathy patients — shared SNOMED lineage",
  },

  // Cardiovascular.
  {
    childCode: "22298006",
    parentCode: "55822004",
    rationale: "Myocardial infarction is a recognized complication of hyperlipidemia/atherosclerosis",
  },
  {
    childCode: "401303003",
    parentCode: "22298006",
    rationale: "Acute STEMI is a specific MI presentation — refines the parent MI concept",
  },
  {
    childCode: "401314000",
    parentCode: "22298006",
    rationale: "Acute NSTEMI is a specific MI presentation",
  },
  {
    childCode: "399211009",
    parentCode: "22298006",
    rationale: "History of MI is a downstream 'situation' code for MI",
  },
  {
    childCode: "399261000",
    parentCode: "22298006",
    rationale: "History of CABG follows MI / CAD",
  },

  // Hypertension → cardiovascular chain.
  {
    childCode: "22298006",
    parentCode: "59621000",
    rationale: "MI is a well-established complication of essential hypertension",
  },
];
