/**
 * EHR tool definitions and executors for non-Claude models.
 * These mirror the MCP tools but execute directly against the local Kuzu database.
 */

import { getConnection, withLock } from "./kuzu-client.js";
import { recordTool, metricsEnabled } from "./metrics.js";

// ─── Tool definitions (OpenAI function-calling format, used by Ollama) ───────

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_patients",
      description: "Find patient records by name or city using full-text search. Returns patient_id + name + city for matches. Use this when the question names a specific patient (e.g. 'What medications is John Smith on?'). Do NOT use for cohort queries — use find_cohort instead.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Name fragment or city, e.g. 'John Smith' or 'Boston'" },
          limit: { type: "number", description: "Maximum results (default 20, max 50)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_patient_summary",
      description: "Get a clinical overview of a patient. ONLY use this for open-ended 'tell me about patient X' or 'overall complexity' questions. For any narrower question (demographics, labs, meds, conditions, procedures) use the matching dedicated tool (get_medications/get_diagnoses/get_labs/get_procedures) or pass `scope` to fetch a single section — this drastically shrinks the response on large records. All sections are truncated (30 labs, 20 encounters, 30 procedures, 50 conditions, 50 medications) with `*_truncated` flags; re-query a specific tool for the full set when needed.",
      parameters: {
        type: "object",
        required: ["patient_id"],
        properties: {
          patient_id: { type: "string", description: "The patient ID to look up" },
          scope: {
            type: "string",
            enum: ["demographics", "conditions", "medications", "labs", "encounters", "procedures", "all"],
            description: "Limit the summary to a single section. Default 'all'. Use 'demographics' for simple demographic questions so the model doesn't have to wade through unrelated clinical data.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_medications",
      description: "Get medications for a patient, optionally filtered by active status or name. Example: {patient_id: 'abc-123', active: true, name: 'metformin'}. Prefer this over get_patient_summary when the question is scoped to medications.",
      parameters: {
        type: "object",
        required: ["patient_id"],
        properties: {
          patient_id: { type: "string", description: "The patient ID" },
          active: { type: "boolean", description: "If true, only return medications with no stop_date" },
          name: { type: "string", description: "Filter by medication name (case-insensitive partial match)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_diagnoses",
      description: "Get medical conditions/diagnoses for a patient. By default excludes SNOMED '(finding)' entries (social determinants like 'Full-time employment', 'Educated to high school level') which are co-mingled with clinical diagnoses in SNOMED-CT — set include_findings=true to include them. Example: {patient_id: 'abc-123', status: 'active'}.",
      parameters: {
        type: "object",
        required: ["patient_id"],
        properties: {
          patient_id: { type: "string", description: "The patient ID" },
          status: { type: "string", enum: ["active", "resolved"], description: "active = stop_date is null/empty, resolved = stop_date is set" },
          include_findings: { type: "boolean", description: "Include SNOMED '(finding)' entries (SDoH, education, employment). Default false." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_labs",
      description: "Get lab results for a patient, optionally filtered by LOINC code or date range. Returns up to 50 most recent results. Example: {patient_id: 'abc-123', code: '4548-4'} for HbA1c only. When the question names a lab by common name, call find_observation_concepts FIRST to get the LOINC code, then filter by code here — description-based filtering can miss verbose LOINC names.",
      parameters: {
        type: "object",
        required: ["patient_id"],
        properties: {
          patient_id: { type: "string", description: "The patient ID" },
          code: { type: "string", description: "LOINC code to filter by, e.g. '4548-4' (HbA1c), '2093-3' (Total Cholesterol)" },
          start_date: { type: "string", description: "Inclusive lower bound (YYYY-MM-DD)" },
          end_date: { type: "string", description: "Inclusive upper bound (YYYY-MM-DD)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_procedures",
      description: "Get procedures performed on a patient. Optionally filter by date range or by encounter_id (use this when the question asks 'what procedures were done during the ED visit / the last encounter / a specific encounter'). Returns description, SNOMED code, start/stop dates, and the encounter they occurred in.",
      parameters: {
        type: "object",
        required: ["patient_id"],
        properties: {
          patient_id: { type: "string", description: "The patient ID" },
          encounter_id: { type: "string", description: "Filter to procedures done during a specific encounter (useful for 'what procedures during the ED visit' after finding that encounter's ID)" },
          start_date: { type: "string", description: "Inclusive lower bound on procedure start date (YYYY-MM-DD)" },
          end_date: { type: "string", description: "Inclusive upper bound (YYYY-MM-DD)" },
          limit: { type: "number", description: "Max results (default 50)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_cohort",
      description: "Find patients matching clinical criteria (conditions, medications, age, gender). Returns up to 100 matching patients with their IDs, names, birth dates, gender. Use for 'which patients have X?' questions. If you only need a count, use count_cohort instead (saves tokens at large N). All condition/medication filters are case-insensitive partial matches (e.g. 'diabetes' matches 'Diabetes mellitus Type 2'). Example: {conditions: ['diabetes'], medications: ['metformin'], age_min: 50}.",
      parameters: {
        type: "object",
        properties: {
          conditions: { type: "array", items: { type: "string" }, description: "Condition descriptions (partial match, ALL must be present on the patient)" },
          medications: { type: "array", items: { type: "string" }, description: "Medication descriptions (partial match, ALL must be present)" },
          age_min: { type: "number", description: "Minimum age in years (computed from birth_date at query time)" },
          age_max: { type: "number", description: "Maximum age in years" },
          gender: { type: "string", description: "Gender filter, 'M' or 'F'" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rank_conditions_in_cohort",
      description: "Return the top-N most frequent conditions in a cohort (filtered by gender/age/existing conditions/medications). USE THIS for 'most common conditions in X patients' questions — there is no other efficient way to answer these, and looping get_diagnoses per patient will blow out context. Excludes SNOMED '(finding)' entries (SDoH) by default; pass include_findings=true to include them. Returns a list of {description, code, patient_count} rows.",
      parameters: {
        type: "object",
        properties: {
          gender: { type: "string", description: "Gender filter, 'M' or 'F'" },
          age_min: { type: "number", description: "Minimum age in years" },
          age_max: { type: "number", description: "Maximum age in years" },
          conditions: { type: "array", items: { type: "string" }, description: "Patients must ALSO have these conditions (partial match)" },
          medications: { type: "array", items: { type: "string" }, description: "Patients must ALSO be on these medications (partial match)" },
          include_findings: { type: "boolean", description: "Include SNOMED '(finding)' entries (employment, education, housing). Default false." },
          limit: { type: "number", description: "Top-N conditions to return (default 10, max 100)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_observation_concepts",
      description: "Search for observation/lab concept nodes by clinical name. Returns matching LOINC codes with their official descriptions and units. ALWAYS call this first when a question mentions a lab by its common name (e.g. 'Total Cholesterol', 'HbA1c', 'BP'). LOINC descriptions are verbose and specimen-qualified (e.g. 'Cholesterol [Mass/volume] in Serum or Plasma', not 'Cholesterol'), so a literal description match against clinical shorthand will usually miss.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Clinical name to search for, e.g. 'cholesterol', 'hemoglobin', 'glucose'" },
          limit: { type: "number", description: "Maximum results (default 10)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cohort_observation_distribution",
      description: "Return the DISTRIBUTION of an observation (histogram + counts above/below thresholds) across a cohort of patients matching a condition. Use this for questions about spread, tails, or thresholds: 'how many diabetics have A1c > 9?', 'what fraction of hyperlipidemia patients have cholesterol between 200-240?'. Do NOT use this for a single aggregate statistic — use aggregate_observation_for_cohort for avg/min/max/median. Uses the most-recent value per patient. Example: {condition: 'diabetes', observation_code: '4548-4', thresholds: [7, 9]} returns counts in buckets (-inf, 7], (7, 9], (9, +inf).",
      parameters: {
        type: "object",
        required: ["condition"],
        properties: {
          condition: { type: "string", description: "Condition filter (partial match)" },
          observation: { type: "string", description: "Observation description filter. Required unless observation_code is given." },
          observation_code: { type: "string", description: "Exact LOINC code (preferred)" },
          thresholds: {
            type: "array",
            items: { type: "number" },
            description: "Bucket boundaries (ascending). [7, 9] → 3 buckets: (-inf,7], (7,9], (9,+inf). If omitted, returns 5 equal-width buckets from min to max.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_observations",
      description: "Compare two values of the same lab for a patient over time — returns the two values, delta, direction (rising/falling/stable), and days between. Use this instead of calling get_labs and subtracting values yourself. By default compares the earliest and latest value; pass date_a/date_b to compare values nearest to specific dates. Example: {patient_id: 'abc', observation_code: '4548-4'} returns first vs most recent HbA1c.",
      parameters: {
        type: "object",
        required: ["patient_id", "observation_code"],
        properties: {
          patient_id: { type: "string", description: "The patient ID" },
          observation_code: { type: "string", description: "LOINC code of the observation to compare" },
          date_a: { type: "string", description: "Optional — compare the value nearest to this date (YYYY-MM-DD). If omitted, uses earliest value." },
          date_b: { type: "string", description: "Optional — compare the value nearest to this date. If omitted, uses most recent value." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_temporal_relation",
      description: "For a single patient, determine which of two clinical events came first and the days between them. Use this for 'did X happen before Y?' questions instead of calling two separate retrieval tools and subtracting dates yourself. Each event is specified by kind + code (preferred) or kind + description (partial match). If multiple records match an event spec, returns the earliest. Example: {patient_id: 'abc', event_a: {kind: 'condition', description: 'diabetes'}, event_b: {kind: 'medication', code: '860975'}}.",
      parameters: {
        type: "object",
        required: ["patient_id", "event_a", "event_b"],
        properties: {
          patient_id: { type: "string", description: "The patient ID" },
          event_a: {
            type: "object",
            description: "First event to locate on the timeline",
            required: ["kind"],
            properties: {
              kind: { type: "string", enum: ["condition", "medication", "observation", "procedure", "encounter"] },
              code: { type: "string", description: "Exact code (SNOMED/RxNorm/LOINC) — preferred" },
              description: { type: "string", description: "Partial description match — used if code not given" },
            },
          },
          event_b: {
            type: "object",
            description: "Second event to locate",
            required: ["kind"],
            properties: {
              kind: { type: "string", enum: ["condition", "medication", "observation", "procedure", "encounter"] },
              code: { type: "string" },
              description: { type: "string" },
            },
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_patient_age",
      description: "Compute a patient's age in years, server-side. Use this instead of computing age yourself from birth_date — avoids off-by-one errors around birthdays and leap years. Example: {patient_id: 'abc-123'} returns current age; {patient_id: 'abc-123', as_of: '2020-06-01'} returns age on that date.",
      parameters: {
        type: "object",
        required: ["patient_id"],
        properties: {
          patient_id: { type: "string", description: "The patient ID" },
          as_of: { type: "string", description: "Optional reference date (YYYY-MM-DD). Defaults to today. If the patient died before this date, returns age at death instead." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "count_cohort",
      description: "Return ONLY the count of patients matching clinical criteria — no patient list. Use this instead of find_cohort when the question only needs a number ('how many patients have diabetes?'). At tier-20k scale, a full find_cohort result can exceed context limits; count_cohort does not. Same filter semantics as find_cohort.",
      parameters: {
        type: "object",
        properties: {
          conditions: { type: "array", items: { type: "string" }, description: "Condition descriptions (partial match, ALL must be present)" },
          medications: { type: "array", items: { type: "string" }, description: "Medication descriptions (partial match, ALL must be present)" },
          age_min: { type: "number", description: "Minimum age in years" },
          age_max: { type: "number", description: "Maximum age in years" },
          gender: { type: "string", description: "'M' or 'F'" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aggregate_observation_for_cohort",
      description: "Compute an aggregate statistic (avg/min/max/sum/count/median) of the most-recent observation value across a cohort of patients matching a condition. ALWAYS use this for cohort aggregation questions like 'what is the average HbA1c for diabetics?' — do NOT loop get_labs per patient, that hits context limits and is much slower. For distribution questions ('how many diabetics have A1c>9?'), use cohort_observation_distribution instead. Example: {condition: 'diabetes', observation_code: '4548-4', aggregation: 'avg'}.",
      parameters: {
        type: "object",
        properties: {
          condition: { type: "string", description: "Condition description filter (partial match), e.g. 'Hyperlipidemia'" },
          observation: { type: "string", description: "Observation description filter (partial match), e.g. 'Total Cholesterol'. Required unless observation_code is given." },
          observation_code: { type: "string", description: "Optional exact LOINC code (e.g. '2093-3') — preferred over description filter when known" },
          aggregation: { type: "string", enum: ["avg", "min", "max", "sum", "count", "median"], description: "Aggregation function to apply across per-patient most-recent values" },
        },
        required: ["condition", "aggregation"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_medication_adherence",
      description: "Compute medication adherence metrics for a patient + medication: total days prescribed, gap days (intervals between a stop_date and the next start_date of the same med), days-covered-ratio, and a coarse adherence flag. Use this instead of fetching all prescriptions and doing date math yourself. Example: {patient_id: 'abc', medication_code: '860975'} for metformin. Pass medication_name for partial description match if no code is known.",
      parameters: {
        type: "object",
        required: ["patient_id"],
        properties: {
          patient_id: { type: "string", description: "The patient ID" },
          medication_code: { type: "string", description: "Exact RxNorm code — preferred" },
          medication_name: { type: "string", description: "Partial description match used if medication_code is not given" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_encounter_detail",
      description: "Fetch one encounter with everything that happened at it: conditions diagnosed, medications prescribed, labs drawn, procedures performed (all joined via encounter_id on the relationship edges). Use for 'what happened at the visit on X date?' questions. To locate the encounter_id first, call get_patient_summary with scope='encounters'.",
      parameters: {
        type: "object",
        required: ["encounter_id"],
        properties: {
          encounter_id: { type: "string", description: "The encounter_id (not patient_id) — the specific visit to describe" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_treatments_for_condition",
      description: "List medications that are commonly prescribed for a given condition across the cohort. Uses the ConceptMedication-[TREATS]->ConceptCondition edge derived from prescription reason codes, plus actual prescription counts. Answers 'what's typically used to treat X?' questions at graph speed — no cohort scan. Example: {condition: 'diabetes'} returns metformin, insulin, etc. ranked by prescription volume.",
      parameters: {
        type: "object",
        required: ["condition"],
        properties: {
          condition: { type: "string", description: "Condition description (partial match) or exact SNOMED code" },
          limit: { type: "number", description: "Maximum medications to return (default 20)" },
        },
      },
    },
  },
];

// ─── Tool executors ──────────────────────────────────────────────────────────

// SNOMED-CT filing quirk: some clinically meaningful diagnoses are filed as
// "(finding)" rather than "(disorder)". The blanket `(finding)` exclusion we
// use to hide SDoH entries (employment, education, housing) would also hide
// these real diagnoses — so we keep a small allow-list of findings to let
// through. Observed in the 2026-04-23 smoke matrix: TMP-65 (prediabetes-date
// question) failed across all tiers because "Prediabetes (finding)" got
// filtered out. Expand this list as clinicians identify more.
//
// Strings must match the full Synthea description including the "(finding)"
// suffix. Case-sensitive.
const CLINICAL_FINDINGS_ALLOWLIST: readonly string[] = [
  "Prediabetes (finding)",              // 714628002 — diagnosed state, not SDoH
  "Hypoxemia (finding)",                // 389087006 — clinical event
  "Hyperglycemia (finding)",            // 80394007  — diabetes adjacent
  "Hypoglycemia (finding)",             // 302866003
  "Proteinuria (finding)",              // 29738008  — renal marker
  "Microalbuminuria (finding)",         // 59100009
  "Loss of taste (finding)",            // 36955009  — post-viral
];

// Render the allow-list as a Cypher list literal for use in a WHERE clause.
// Call sites use this pattern:
//   `NOT c.description ENDS WITH '(finding)' OR c.description IN [${findingsAllowlistCypher()}]`
// which lets disorders through, suppresses SDoH findings, and exempts the
// clinically meaningful findings above.
function findingsAllowlistCypher(): string {
  return CLINICAL_FINDINGS_ALLOWLIST
    .map((s) => `'${s.replace(/'/g, "''")}'`)
    .join(", ");
}

// Kuzu returns DATE columns as JS Date objects. Convert to YYYY-MM-DD strings
// so tool responses stay comparable to the old STRING-dated schema. Numeric,
// boolean, null stay as-is.
function normalizeDates(row: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v instanceof Date) row[k] = v.toISOString().slice(0, 10);
  }
  return row;
}

async function q(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  return withLock(async () => {
    const c = await getConnection();
    if (params && Object.keys(params).length > 0) {
      const prep = await c.prepare(cypher);
      const result = await c.execute(prep, params);
      return ((await result.getAll()) as Record<string, unknown>[]).map(normalizeDates);
    }
    const result = await c.query(cypher);
    return ((await result.getAll()) as Record<string, unknown>[]).map(normalizeDates);
  });
}

type ToolArgs = Record<string, unknown>;

// Calendar-correct age calculation — years between two ISO dates, not subtracting
// month-and-day. Returns integer age; handles pre-birthday case (e.g. born
// 2000-06-15, as-of 2025-03-01 → 24, not 25).
function yearsBetween(birthIso: string, asOfIso: string): number {
  const b = new Date(birthIso);
  const a = new Date(asOfIso);
  let years = a.getUTCFullYear() - b.getUTCFullYear();
  const monthDiff = a.getUTCMonth() - b.getUTCMonth();
  const dayDiff = a.getUTCDate() - b.getUTCDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) years--;
  return years;
}

// Locate the earliest-matching date for a (kind, code|description) event spec on a patient.
// Used by get_temporal_relation and compare_observations.
interface EventSpec { kind?: string; code?: string; description?: string }
interface EventDate { kind: string; code: string | null; description: string | null; date: string }
async function findEventDate(patientId: string, spec: EventSpec): Promise<EventDate | { error: string }> {
  const kind = spec.kind;
  const code = spec.code ?? null;
  const desc = spec.description ?? null;

  if (!kind) return { error: "event kind is required" };
  if (!code && !desc) return { error: `event of kind '${kind}' needs a code or description` };

  const descFilter = code
    ? "x.code = $code"
    : "LOWER(x.description) CONTAINS LOWER($descText)";
  const params: Record<string, unknown> = { pid: patientId };
  if (code) params.code = code;
  else params.descText = desc;

  let cypher: string;
  switch (kind) {
    case "condition":
      cypher = `MATCH (:Patient {patient_id: $pid})-[r:DIAGNOSED_WITH]->(x:ConceptCondition)
                WHERE ${descFilter}
                RETURN r.start_date AS date, x.code AS code, x.description AS description
                ORDER BY r.start_date ASC LIMIT 1`;
      break;
    case "medication":
      cypher = `MATCH (:Patient {patient_id: $pid})-[r:PRESCRIBED]->(x:ConceptMedication)
                WHERE ${descFilter}
                RETURN r.start_date AS date, x.code AS code, x.description AS description
                ORDER BY r.start_date ASC LIMIT 1`;
      break;
    case "observation":
      cypher = `MATCH (:Patient {patient_id: $pid})-[r:HAS_RESULT]->(x:ConceptObservation)
                WHERE ${descFilter}
                RETURN r.date AS date, x.code AS code, x.description AS description
                ORDER BY r.date ASC LIMIT 1`;
      break;
    case "procedure":
      cypher = `MATCH (:Patient {patient_id: $pid})-[r:UNDERWENT]->(x:ConceptProcedure)
                WHERE ${descFilter}
                RETURN r.start_date AS date, x.code AS code, x.description AS description
                ORDER BY r.start_date ASC LIMIT 1`;
      break;
    case "encounter": {
      // Encounters are instance nodes; filter on their own properties
      const encFilter = code
        ? "x.code = $code"
        : "LOWER(x.description) CONTAINS LOWER($descText) OR LOWER(x.reason_description) CONTAINS LOWER($descText)";
      cypher = `MATCH (:Patient {patient_id: $pid})-[:HAD_ENCOUNTER]->(x:Encounter)
                WHERE ${encFilter}
                RETURN x.start_date AS date, x.code AS code, x.description AS description
                ORDER BY x.start_date ASC LIMIT 1`;
      break;
    }
    default:
      return { error: `Unknown event kind: ${kind}` };
  }

  const [row] = await q(cypher, params);
  if (!row || !row.date) return { error: `No ${kind} matching ${code ?? desc} for patient` };
  return {
    kind,
    code: (row.code as string) ?? null,
    description: (row.description as string) ?? null,
    date: String(row.date),
  };
}

// Shared Cypher builder for cohort filters (used by find_cohort and count_cohort).
// Returns a MATCH clause list, WHERE clause, and param bag for prepared execution.
// Case-insensitive CONTAINS on condition/medication descriptions — descriptions
// vary in capitalization across related records.
function buildCohortFilter(args: ToolArgs): { match: string; where: string; params: Record<string, unknown> } {
  const matchClauses = ["MATCH (p:Patient)"];
  const whereClauses: string[] = [];
  const params: Record<string, unknown> = {};

  const conditions = (args.conditions as string[]) ?? [];
  conditions.forEach((cond, i) => {
    const key = `cond${i}`;
    params[key] = cond;
    matchClauses.push(`MATCH (p)-[:DIAGNOSED_WITH]->(c${i}:ConceptCondition)`);
    whereClauses.push(`LOWER(c${i}.description) CONTAINS LOWER($${key})`);
  });

  const medications = (args.medications as string[]) ?? [];
  medications.forEach((med, i) => {
    const key = `med${i}`;
    params[key] = med;
    matchClauses.push(`MATCH (p)-[:PRESCRIBED]->(m${i}:ConceptMedication)`);
    whereClauses.push(`LOWER(m${i}.description) CONTAINS LOWER($${key})`);
  });

  if (args.gender) {
    params.gender = String(args.gender);
    whereClauses.push("p.gender = $gender");
  }
  // Uses Patient.age_years (INT64 precomputed at ingest) — avoids birth_date
  // arithmetic per query and avoids the off-by-one that simple year-subtraction
  // causes around birthdays.
  if (args.age_min != null) {
    params.ageMin = Number(args.age_min);
    whereClauses.push("p.age_years >= $ageMin");
  }
  if (args.age_max != null) {
    params.ageMax = Number(args.age_max);
    whereClauses.push("p.age_years <= $ageMax");
  }

  return {
    match: matchClauses.join("\n"),
    where: whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "",
    params,
  };
}

const executors: Record<string, (args: ToolArgs) => Promise<unknown>> = {
  async search_patients(args) {
    const query = String(args.query ?? "");
    const limit = Math.min(Number(args.limit) || 20, 50);
    const rows = await q(
      `CALL QUERY_FTS_INDEX('Patient', 'patient_fts', $query)
       RETURN node.patient_id AS id, node.first_name AS first_name,
              node.last_name AS last_name, node.city AS city, score
       ORDER BY score DESC LIMIT ${limit}`,
      { query },
    );
    return rows.map((r) => ({
      patient_id: r.id,
      name: `${r.first_name} ${r.last_name}`,
      city: r.city,
    }));
  },

  async get_patient_summary(args) {
    const id = String(args.patient_id);
    const scope = (args.scope as string | undefined) ?? "all";
    const want = (section: string) => scope === "all" || scope === section;

    const [patient] = await q(
      `MATCH (p:Patient {patient_id: $id})
       RETURN p.first_name AS first_name, p.last_name AS last_name,
              p.birth_date AS birth_date, p.death_date AS death_date,
              p.gender AS gender, p.race AS race, p.ethnicity AS ethnicity,
              p.city AS city, p.state AS state`,
      { id },
    );
    if (!patient) return { error: `Patient ${id} not found` };

    // scope='demographics' short-circuits — skip every other query so a narrow
    // demographic question doesn't pull (and then have to summarize) the full
    // record. This is the main reason scope exists: small models over-wrote
    // everything when given the big blob.
    if (scope === "demographics") {
      return { patient: { patient_id: id, ...patient } };
    }

    const LAB_LIMIT = 30;
    const ENC_LIMIT = 20;
    const PROC_LIMIT = 30;
    // Top-level caps on the "unbounded" sections. Patients at tier-20000 can
    // have hundreds of co-conditions and lifetime prescriptions; unbounded
    // returns drove qwen2.5:32b into 30–48 minute summary generations in the
    // 2026-04-23 smoke matrix. Cap with a `truncated` flag; the caller can
    // always re-query via the dedicated tool (get_diagnoses, get_medications)
    // when they need the full set.
    const COND_LIMIT = 50;
    const MED_LIMIT = 50;

    // Synthea encodes SDoH entries as SNOMED (finding) nodes on the same
    // DIAGNOSED_WITH edge as disorders. Exclude them here so "tell me about
    // this patient" doesn't lead with "Full-time employment" alongside actual
    // diagnoses. Mirrors the get_diagnoses default.
    const conditions = want("conditions")
      ? await q(
          `MATCH (p:Patient {patient_id: $id})-[r:DIAGNOSED_WITH]->(c:ConceptCondition)
           WHERE NOT c.description ENDS WITH '(finding)'
              OR c.description IN [${findingsAllowlistCypher()}]
           RETURN c.description AS description, r.start_date AS start_date, r.stop_date AS stop_date
           ORDER BY r.start_date DESC LIMIT ${COND_LIMIT + 1}`,
          { id },
        )
      : [];
    const conditionsTruncated = conditions.length > COND_LIMIT;
    const conditionsShown = conditionsTruncated ? conditions.slice(0, COND_LIMIT) : conditions;

    const medications = want("medications")
      ? await q(
          `MATCH (p:Patient {patient_id: $id})-[r:PRESCRIBED]->(m:ConceptMedication)
           RETURN m.description AS description, r.start_date AS start_date, r.stop_date AS stop_date
           ORDER BY r.start_date DESC LIMIT ${MED_LIMIT + 1}`,
          { id },
        )
      : [];
    const medicationsTruncated = medications.length > MED_LIMIT;
    const medicationsShown = medicationsTruncated ? medications.slice(0, MED_LIMIT) : medications;

    const labs = want("labs")
      ? await q(
          `MATCH (p:Patient {patient_id: $id})-[r:HAS_RESULT]->(o:ConceptObservation)
           RETURN o.description AS description, r.value AS value, r.units AS units, r.date AS date
           ORDER BY r.date DESC LIMIT ${LAB_LIMIT + 1}`,
          { id },
        )
      : [];
    const labsTruncated = labs.length > LAB_LIMIT;
    const labsShown = labsTruncated ? labs.slice(0, LAB_LIMIT) : labs;

    const encounters = want("encounters")
      ? await q(
          `MATCH (p:Patient {patient_id: $id})-[:HAD_ENCOUNTER]->(e:Encounter)-[:TREATED_BY]->(prov:Provider)
           RETURN e.encounter_class AS class, e.description AS description,
                  e.start_date AS date, e.reason_description AS reason,
                  prov.name AS provider_name, prov.specialty AS provider_specialty
           ORDER BY e.start_date DESC LIMIT ${ENC_LIMIT + 1}`,
          { id },
        )
      : [];
    const encountersTruncated = encounters.length > ENC_LIMIT;
    const encountersShown = encountersTruncated ? encounters.slice(0, ENC_LIMIT) : encounters;

    const procedures = want("procedures")
      ? await q(
          `MATCH (p:Patient {patient_id: $id})-[r:UNDERWENT]->(pr:ConceptProcedure)
           RETURN pr.description AS description, pr.code AS code,
                  r.start_date AS start_date, r.stop_date AS stop_date,
                  r.encounter_id AS encounter_id
           ORDER BY r.start_date DESC LIMIT ${PROC_LIMIT + 1}`,
          { id },
        )
      : [];
    const proceduresTruncated = procedures.length > PROC_LIMIT;
    const proceduresShown = proceduresTruncated ? procedures.slice(0, PROC_LIMIT) : procedures;

    const [labCountRow] = labsTruncated
      ? await q(
          `MATCH (p:Patient {patient_id: $id})-[r:HAS_RESULT]->(:ConceptObservation)
           RETURN count(r) AS cnt`,
          { id },
        )
      : [{ cnt: labs.length }];
    const [encCountRow] = encountersTruncated
      ? await q(
          `MATCH (p:Patient {patient_id: $id})-[:HAD_ENCOUNTER]->(e:Encounter)
           RETURN count(e) AS cnt`,
          { id },
        )
      : [{ cnt: encounters.length }];

    // When scope narrows, return only that section's fields. Callers of
    // scope='conditions' etc. don't need the demographics wrapper.
    if (scope === "conditions") {
      return {
        patient_id: id,
        conditions: conditionsShown.map((r) => ({
          description: r.description,
          start_date: r.start_date,
          stop_date: r.stop_date,
          status: r.stop_date ? "resolved" : "active",
        })),
        conditions_truncated: conditionsTruncated,
      };
    }
    if (scope === "medications") {
      return {
        patient_id: id,
        medications: medicationsShown.map((r) => ({
          description: r.description,
          start_date: r.start_date,
          stop_date: r.stop_date,
          status: r.stop_date ? "stopped" : "active",
        })),
        medications_truncated: medicationsTruncated,
      };
    }
    if (scope === "labs") {
      return {
        patient_id: id,
        recent_labs: labsShown.map((r) => ({
          description: r.description,
          value: r.value,
          units: r.units,
          date: r.date,
        })),
        recent_labs_truncated: labsTruncated,
        total_lab_count: Number(labCountRow?.cnt ?? labs.length),
      };
    }
    if (scope === "encounters") {
      return {
        patient_id: id,
        recent_encounters: encountersShown.map((r) => ({
          class: r.class,
          description: r.description,
          date: r.date,
          reason: r.reason,
          provider_name: r.provider_name,
          provider_specialty: r.provider_specialty,
        })),
        recent_encounters_truncated: encountersTruncated,
        total_encounter_count: Number(encCountRow?.cnt ?? encounters.length),
      };
    }
    if (scope === "procedures") {
      return {
        patient_id: id,
        recent_procedures: proceduresShown.map((r) => ({
          description: r.description,
          code: r.code,
          start_date: r.start_date,
          stop_date: r.stop_date,
          encounter_id: r.encounter_id,
        })),
        recent_procedures_truncated: proceduresTruncated,
      };
    }

    return {
      patient: { patient_id: id, ...patient },
      conditions: conditionsShown.map((r) => ({
        description: r.description,
        start_date: r.start_date,
        stop_date: r.stop_date,
        status: r.stop_date ? "resolved" : "active",
      })),
      conditions_truncated: conditionsTruncated,
      medications: medicationsShown.map((r) => ({
        description: r.description,
        start_date: r.start_date,
        stop_date: r.stop_date,
        status: r.stop_date ? "stopped" : "active",
      })),
      medications_truncated: medicationsTruncated,
      recent_labs: labsShown.map((r) => ({
        description: r.description,
        value: r.value,
        units: r.units,
        date: r.date,
      })),
      recent_labs_truncated: labsTruncated,
      total_lab_count: Number(labCountRow?.cnt ?? labs.length),
      recent_encounters: encountersShown.map((r) => ({
        class: r.class,
        description: r.description,
        date: r.date,
        reason: r.reason,
        provider_name: r.provider_name,
        provider_specialty: r.provider_specialty,
      })),
      recent_encounters_truncated: encountersTruncated,
      total_encounter_count: Number(encCountRow?.cnt ?? encounters.length),
      recent_procedures: proceduresShown.map((r) => ({
        description: r.description,
        code: r.code,
        start_date: r.start_date,
        stop_date: r.stop_date,
        encounter_id: r.encounter_id,
      })),
      recent_procedures_truncated: proceduresTruncated,
    };
  },

  async get_medications(args) {
    const id = String(args.patient_id);
    const nameFilter = args.name ? String(args.name) : null;
    const activeFilter = Boolean(args.active);

    // Static filter predicates compose; the name param is always bound.
    const wherePieces = ["true"];
    if (activeFilter) wherePieces.push("r.stop_date IS NULL");
    if (nameFilter !== null) wherePieces.push("m.description CONTAINS $name");

    const params: Record<string, unknown> = { id };
    if (nameFilter !== null) params.name = nameFilter;

    const rows = await q(
      `MATCH (p:Patient {patient_id: $id})-[r:PRESCRIBED]->(m:ConceptMedication)
       WHERE ${wherePieces.join(" AND ")}
       RETURN m.description AS description, m.code AS code,
              r.start_date AS start_date, r.stop_date AS stop_date`,
      params,
    );
    return rows;
  },

  async get_diagnoses(args) {
    const id = String(args.patient_id);
    const wherePieces = ["true"];
    if (args.status === "active") wherePieces.push("r.stop_date IS NULL");
    if (args.status === "resolved") wherePieces.push("r.stop_date IS NOT NULL AND r.stop_date <> ''");
    // SNOMED-CT co-mingles SDoH 'finding' concepts (employment, education,
    // housing) with clinical 'disorder' concepts. Filter them out by default
    // so "list active problems" returns clinically-relevant diagnoses — but
    // exempt the small allow-list of clinically meaningful findings (e.g.
    // Prediabetes (finding)) so they still surface.
    if (!args.include_findings) {
      wherePieces.push(`(NOT c.description ENDS WITH '(finding)' OR c.description IN [${findingsAllowlistCypher()}])`);
    }

    const rows = await q(
      `MATCH (p:Patient {patient_id: $id})-[r:DIAGNOSED_WITH]->(c:ConceptCondition)
       WHERE ${wherePieces.join(" AND ")}
       RETURN c.description AS description, c.code AS code,
              r.start_date AS start_date, r.stop_date AS stop_date`,
      { id },
    );
    return rows;
  },

  async get_labs(args) {
    const id = String(args.patient_id);
    const params: Record<string, unknown> = { id };
    const wherePieces = ["true"];
    if (args.code) { wherePieces.push("o.code = $code"); params.code = String(args.code); }
    if (args.start_date) { wherePieces.push("r.date >= $startDate"); params.startDate = String(args.start_date); }
    if (args.end_date) { wherePieces.push("r.date <= $endDate"); params.endDate = String(args.end_date); }

    const rows = await q(
      `MATCH (p:Patient {patient_id: $id})-[r:HAS_RESULT]->(o:ConceptObservation)
       WHERE ${wherePieces.join(" AND ")}
       RETURN o.description AS description, o.code AS code,
              r.value AS value, r.units AS units, o.category AS category,
              r.date AS date
       ORDER BY r.date DESC LIMIT 50`,
      params,
    );
    return rows;
  },

  async get_procedures(args) {
    const id = String(args.patient_id);
    const limit = Math.min(Number(args.limit) || 50, 200);
    const params: Record<string, unknown> = { id };
    const wherePieces = ["true"];
    if (args.encounter_id) { wherePieces.push("r.encounter_id = $encounterId"); params.encounterId = String(args.encounter_id); }
    if (args.start_date) { wherePieces.push("r.start_date >= $startDate"); params.startDate = String(args.start_date); }
    if (args.end_date) { wherePieces.push("r.start_date <= $endDate"); params.endDate = String(args.end_date); }

    const rows = await q(
      `MATCH (p:Patient {patient_id: $id})-[r:UNDERWENT]->(pr:ConceptProcedure)
       WHERE ${wherePieces.join(" AND ")}
       RETURN pr.description AS description, pr.code AS code,
              r.start_date AS start_date, r.stop_date AS stop_date,
              r.encounter_id AS encounter_id
       ORDER BY r.start_date DESC LIMIT ${limit}`,
      params,
    );
    return rows;
  },

  async find_observation_concepts(args) {
    const query = String(args.query ?? "");
    const limit = Math.min(Number(args.limit) || 10, 50);
    if (!query) return { error: "'query' is required" };

    // Try FTS first (fast, handles fuzzy matching)
    try {
      const rows = await q(
        `CALL QUERY_FTS_INDEX('ConceptObservation', 'observation_fts', $query)
         RETURN node.code AS code, node.description AS description, node.units AS units, score
         ORDER BY score DESC LIMIT ${limit}`,
        { query },
      );
      if (rows.length > 0) {
        return rows.map((r) => ({
          code: r.code,
          description: r.description,
          units: r.units,
          score: r.score,
        }));
      }
    } catch {
      // FTS index may not exist for observations — fall through to CONTAINS
    }

    // Fallback: case-insensitive CONTAINS on each whitespace-split word.
    // Each word becomes a positional parameter $w0, $w1, ... joined with OR.
    const words = query.split(/\s+/).filter(w => w.length >= 3);
    const effectiveWords = words.length > 0 ? words : [query];
    const params: Record<string, unknown> = {};
    const clauses = effectiveWords.map((w, i) => {
      const key = `w${i}`;
      params[key] = w;
      return `o.description CONTAINS $${key}`;
    });
    const rows = await q(
      `MATCH (o:ConceptObservation) WHERE ${clauses.join(" OR ")}
       RETURN o.code AS code, o.description AS description, o.units AS units LIMIT ${limit}`,
      params,
    );
    return rows.map((r) => ({
      code: r.code,
      description: r.description,
      units: r.units,
    }));
  },

  async aggregate_observation_for_cohort(args) {
    const condition = String(args.condition ?? "");
    const obsDesc = args.observation ? String(args.observation) : null;
    const obsCode = args.observation_code ? String(args.observation_code) : null;
    const agg = String(args.aggregation ?? "avg").toLowerCase();

    const validAggs = ["avg", "min", "max", "sum", "count", "median"];
    if (!validAggs.includes(agg)) {
      return { error: `Invalid aggregation '${agg}'. Must be one of: ${validAggs.join(", ")}` };
    }
    if (!obsDesc && !obsCode) {
      return { error: "Either 'observation' or 'observation_code' is required" };
    }
    if (!condition) {
      return { error: "'condition' is required" };
    }

    const obsFilter = obsCode
      ? "o.code = $obsCode"
      : "LOWER(o.description) CONTAINS LOWER($obsDesc)";
    const obsParams = obsCode ? { obsCode } : { obsDesc };

    // Cohort size: distinct patients matching the condition (case-insensitive)
    const [cohortRow] = await q(
      `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c:ConceptCondition)
       WHERE LOWER(c.description) CONTAINS LOWER($condition)
       RETURN count(DISTINCT p) AS cnt`,
      { condition },
    );
    const cohortSize = Number(cohortRow?.cnt ?? 0);

    if (cohortSize === 0) {
      return {
        cohort_size: 0,
        patients_with_observation: 0,
        aggregation: agg,
        value: null,
        note: `No patients found matching condition '${args.condition}'`,
      };
    }

    // Pull all (patient, value, date) tuples for cohort+observation, find latest per patient in JS.
    const rows = await q(
      `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c:ConceptCondition)
       WHERE LOWER(c.description) CONTAINS LOWER($condition)
       MATCH (p)-[r:HAS_RESULT]->(o:ConceptObservation)
       WHERE ${obsFilter}
       RETURN p.patient_id AS pid, r.value AS value, r.units AS units,
              r.date AS date, o.description AS description`,
      { condition, ...obsParams },
    );

    interface Latest { value: number; units: string; desc: string; date: string }
    const latestByPatient = new Map<string, Latest>();
    for (const row of rows) {
      const pid = row.pid as string;
      const value = typeof row.value === "number" ? row.value : parseFloat(String(row.value ?? ""));
      if (!Number.isFinite(value)) continue;
      const units = String(row.units ?? "");
      const date = String(row.date ?? "");
      const existing = latestByPatient.get(pid);
      if (!existing || date > existing.date) {
        latestByPatient.set(pid, {
          value, units,
          desc: String(row.description ?? ""),
          date,
        });
      }
    }

    const values = Array.from(latestByPatient.values()).map(v => v.value);
    if (values.length === 0) {
      return {
        cohort_size: cohortSize,
        patients_with_observation: 0,
        aggregation: agg,
        value: null,
        observation_description: obsDesc ?? obsCode,
        note: "No numeric observations found for the cohort",
      };
    }

    let result: number;
    switch (agg) {
      case "avg":
        result = values.reduce((a, b) => a + b, 0) / values.length;
        break;
      case "min":
        result = Math.min(...values);
        break;
      case "max":
        result = Math.max(...values);
        break;
      case "sum":
        result = values.reduce((a, b) => a + b, 0);
        break;
      case "count":
        result = values.length;
        break;
      case "median": {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        result = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
        break;
      }
      default:
        result = NaN;
    }

    // Sample units/description from any patient's record (they should be uniform for the same observation)
    const sample = latestByPatient.values().next().value as Latest;

    return {
      cohort_size: cohortSize,
      patients_with_observation: latestByPatient.size,
      aggregation: agg,
      value: Math.round(result * 100) / 100,
      units: sample.units || null,
      observation_description: sample.desc || null,
    };
  },

  async find_cohort(args) {
    const { match, where, params } = buildCohortFilter(args);
    const cypher = `${match}
      ${where}
      RETURN DISTINCT p.patient_id AS patient_id, p.first_name AS first_name,
             p.last_name AS last_name, p.birth_date AS birth_date, p.gender AS gender
      LIMIT 100`;

    const rows = await q(cypher, params);
    return {
      count: rows.length,
      patients: rows.map((r) => ({
        patient_id: r.patient_id,
        name: `${r.first_name} ${r.last_name}`,
        birth_date: r.birth_date,
        gender: r.gender,
      })),
    };
  },

  async cohort_observation_distribution(args) {
    const condition = String(args.condition ?? "");
    const obsDesc = args.observation ? String(args.observation) : null;
    const obsCode = args.observation_code ? String(args.observation_code) : null;
    const thresholds = Array.isArray(args.thresholds)
      ? (args.thresholds as number[]).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
      : null;

    if (!condition) return { error: "'condition' is required" };
    if (!obsDesc && !obsCode) return { error: "Either 'observation' or 'observation_code' is required" };

    const obsFilter = obsCode
      ? "o.code = $obsCode"
      : "LOWER(o.description) CONTAINS LOWER($obsDesc)";
    const obsParams = obsCode ? { obsCode } : { obsDesc };

    // Pull (patient, value, date) tuples, latest-per-patient in JS.
    const rows = await q(
      `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c:ConceptCondition)
       WHERE LOWER(c.description) CONTAINS LOWER($condition)
       MATCH (p)-[r:HAS_RESULT]->(o:ConceptObservation)
       WHERE ${obsFilter}
       RETURN p.patient_id AS pid, r.value AS value, r.units AS units,
              r.date AS date, o.description AS description`,
      { condition, ...obsParams },
    );

    interface Latest { value: number; units: string; desc: string; date: string }
    const latest = new Map<string, Latest>();
    for (const row of rows) {
      const pid = row.pid as string;
      const value = typeof row.value === "number" ? row.value : parseFloat(String(row.value ?? ""));
      if (!Number.isFinite(value)) continue;
      const units = String(row.units ?? "");
      const d = String(row.date ?? "");
      const existing = latest.get(pid);
      if (!existing || d > existing.date) {
        latest.set(pid, { value, units, desc: String(row.description ?? ""), date: d });
      }
    }

    const values = [...latest.values()].map((l) => l.value);
    if (values.length === 0) {
      return {
        cohort_size: 0,
        observation_description: obsDesc ?? obsCode,
        buckets: [],
        note: `No numeric observations for condition '${args.condition}'`,
      };
    }

    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const boundaries = thresholds && thresholds.length > 0
      ? thresholds
      : (() => {
          // 5 equal-width buckets from min to max → 4 interior boundaries
          if (minV === maxV) return [minV];
          const step = (maxV - minV) / 5;
          return [1, 2, 3, 4].map((i) => minV + step * i);
        })();

    // Build bucket labels: (-inf, b0], (b0, b1], ..., (bn, +inf)
    const bucketCounts = new Array(boundaries.length + 1).fill(0);
    for (const v of values) {
      let placed = false;
      for (let i = 0; i < boundaries.length; i++) {
        if (v <= boundaries[i]) { bucketCounts[i]++; placed = true; break; }
      }
      if (!placed) bucketCounts[bucketCounts.length - 1]++;
    }

    const bucketLabels = boundaries.map((b, i) => {
      const lower = i === 0 ? "-inf" : String(boundaries[i - 1]);
      return `(${lower}, ${b}]`;
    });
    bucketLabels.push(`(${boundaries[boundaries.length - 1]}, +inf)`);

    const sample = latest.values().next().value as Latest;
    return {
      cohort_size: latest.size,
      observation_description: sample.desc,
      units: sample.units || null,
      min: Math.round(minV * 100) / 100,
      max: Math.round(maxV * 100) / 100,
      buckets: bucketLabels.map((label, i) => ({ range: label, count: bucketCounts[i] })),
      thresholds_used: boundaries,
    };
  },

  async compare_observations(args) {
    const id = String(args.patient_id);
    const code = String(args.observation_code ?? "");
    if (!code) return { error: "observation_code is required" };

    const rows = await q(
      `MATCH (:Patient {patient_id: $id})-[r:HAS_RESULT]->(o:ConceptObservation {code: $code})
       RETURN r.value AS value, r.units AS units,
              r.date AS date, o.description AS description
       ORDER BY r.date ASC`,
      { id, code },
    );
    if (rows.length === 0) return { error: `No observations with code ${code} found for patient ${id}` };
    if (rows.length === 1) {
      return {
        single_value: true,
        value: rows[0].value,
        units: rows[0].units,
        date: rows[0].date,
        description: rows[0].description,
        note: "Only one observation exists; nothing to compare against.",
      };
    }

    const numericRows = rows
      .map((r) => ({
        raw: r,
        num: typeof r.value === "number" ? r.value : parseFloat(String(r.value ?? "")),
      }))
      .filter((r) => Number.isFinite(r.num));
    if (numericRows.length < 2) {
      return { error: `Observations exist but fewer than two have numeric values for code ${code}` };
    }

    const pickNearest = (targetDate: string) =>
      numericRows.reduce((best, cur) => {
        const bestGap = Math.abs(new Date(String(best.raw.date)).getTime() - new Date(targetDate).getTime());
        const curGap = Math.abs(new Date(String(cur.raw.date)).getTime() - new Date(targetDate).getTime());
        return curGap < bestGap ? cur : best;
      });

    const pointA = args.date_a ? pickNearest(String(args.date_a)) : numericRows[0];
    const pointB = args.date_b ? pickNearest(String(args.date_b)) : numericRows[numericRows.length - 1];

    const delta = pointB.num - pointA.num;
    const days = Math.round(
      (new Date(String(pointB.raw.date)).getTime() - new Date(String(pointA.raw.date)).getTime()) / 86_400_000,
    );
    const direction = Math.abs(delta) < 1e-9 ? "stable" : delta > 0 ? "rising" : "falling";

    return {
      observation_code: code,
      description: pointA.raw.description,
      value_a: pointA.num,
      date_a: pointA.raw.date,
      value_b: pointB.num,
      date_b: pointB.raw.date,
      units: pointA.raw.units,
      delta: Math.round(delta * 100) / 100,
      direction,
      days_between: Math.abs(days),
    };
  },

  async get_temporal_relation(args) {
    const id = String(args.patient_id);
    const eventA = args.event_a as { kind?: string; code?: string; description?: string } | undefined;
    const eventB = args.event_b as { kind?: string; code?: string; description?: string } | undefined;
    if (!eventA?.kind || !eventB?.kind) {
      return { error: "Both event_a.kind and event_b.kind are required" };
    }

    const dateA = await findEventDate(id, eventA);
    const dateB = await findEventDate(id, eventB);

    if ("error" in dateA) return { event_a: dateA, event_b: null };
    if ("error" in dateB) return { event_a: dateA, event_b: dateB };

    const daysBetween = Math.abs(
      Math.round((new Date(dateB.date).getTime() - new Date(dateA.date).getTime()) / 86_400_000),
    );
    const order = dateA.date === dateB.date ? "same_day"
      : dateA.date < dateB.date ? "a_before_b"
      : "b_before_a";

    return {
      event_a: dateA,
      event_b: dateB,
      order,
      days_between: daysBetween,
    };
  },

  async get_patient_age(args) {
    const id = String(args.patient_id);
    const [row] = await q(
      `MATCH (p:Patient {patient_id: $id})
       RETURN p.birth_date AS birth_date, p.death_date AS death_date`,
      { id },
    );
    if (!row) return { error: `Patient ${id} not found` };

    const birth = String(row.birth_date ?? "");
    if (!birth) return { error: `Patient ${id} has no birth_date` };

    const death = String(row.death_date ?? "");
    const today = new Date().toISOString().slice(0, 10);
    const asOf = String(args.as_of ?? today);

    // If patient died before the reference date, return age at death
    const reference = death && death < asOf ? death : asOf;
    const age = yearsBetween(birth, reference);

    return {
      patient_id: id,
      age_years: age,
      birth_date: birth,
      as_of: reference,
      deceased: Boolean(death) && death <= asOf,
    };
  },

  async count_cohort(args) {
    const { match, where, params } = buildCohortFilter(args);
    const cypher = `${match}
      ${where}
      RETURN count(DISTINCT p) AS cnt`;

    const [row] = await q(cypher, params);
    return { count: Number(row?.cnt ?? 0) };
  },

  async get_medication_adherence(args) {
    const id = String(args.patient_id);
    const code = args.medication_code ? String(args.medication_code) : null;
    const name = args.medication_name ? String(args.medication_name) : null;
    if (!code && !name) return { error: "Either medication_code or medication_name is required" };

    const filter = code ? "m.code = $code" : "LOWER(m.description) CONTAINS LOWER($name)";
    const params: Record<string, unknown> = { id };
    if (code) params.code = code; else params.name = name;

    const rows = await q(
      `MATCH (:Patient {patient_id: $id})-[r:PRESCRIBED]->(m:ConceptMedication)
       WHERE ${filter}
       RETURN m.code AS code, m.description AS description,
              r.start_date AS start_date, r.stop_date AS stop_date
       ORDER BY r.start_date ASC`,
      params,
    );
    if (rows.length === 0) return { error: `No prescriptions matching ${code ?? name} for patient ${id}` };

    // For adherence, we need pairs of (start, stop) from the same med code. If
    // multiple codes matched the name filter, group first.
    interface Pair { start: string; stop: string | null }
    const byMed = new Map<string, { description: string; pairs: Pair[] }>();
    for (const r of rows) {
      const rx = r.code as string;
      if (!byMed.has(rx)) byMed.set(rx, { description: r.description as string, pairs: [] });
      byMed.get(rx)!.pairs.push({
        start: String(r.start_date),
        stop: r.stop_date ? String(r.stop_date) : null,
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const perMed = [...byMed.entries()].map(([rx, info]) => {
      // Sort by start date, compute gaps between consecutive stop→start
      const pairs = [...info.pairs].sort((a, b) => a.start.localeCompare(b.start));
      let totalDaysOnMed = 0;
      let totalGapDays = 0;
      const gaps: { gap_days: number; between_stop: string; next_start: string }[] = [];

      for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i];
        // Coverage window: start → (stop or today)
        const effectiveStop = p.stop ?? today;
        totalDaysOnMed += Math.max(0, Math.round(
          (new Date(effectiveStop).getTime() - new Date(p.start).getTime()) / 86_400_000,
        ));
        // Gap to next prescription
        if (p.stop && i < pairs.length - 1) {
          const nextStart = pairs[i + 1].start;
          if (nextStart > p.stop) {
            const gapDays = Math.round(
              (new Date(nextStart).getTime() - new Date(p.stop).getTime()) / 86_400_000,
            );
            if (gapDays > 0) {
              totalGapDays += gapDays;
              gaps.push({ gap_days: gapDays, between_stop: p.stop, next_start: nextStart });
            }
          }
        }
      }

      const totalSpan = totalDaysOnMed + totalGapDays;
      const coverageRatio = totalSpan > 0 ? totalDaysOnMed / totalSpan : null;
      // Coarse flag: WHO considers <80% MPR as poor adherence.
      const adherenceFlag = coverageRatio == null ? null
        : coverageRatio >= 0.8 ? "adherent"
        : coverageRatio >= 0.5 ? "partial"
        : "poor";

      return {
        medication_code: rx,
        description: info.description,
        prescription_count: pairs.length,
        first_start: pairs[0].start,
        last_start: pairs[pairs.length - 1].start,
        currently_active: pairs.some((p) => p.stop === null),
        days_covered: totalDaysOnMed,
        gap_days: totalGapDays,
        coverage_ratio: coverageRatio == null ? null : Math.round(coverageRatio * 100) / 100,
        adherence: adherenceFlag,
        gaps,
      };
    });

    return { patient_id: id, medications: perMed };
  },

  async get_encounter_detail(args) {
    const eid = String(args.encounter_id);

    const [encRow] = await q(
      `MATCH (e:Encounter {encounter_id: $eid})
       OPTIONAL MATCH (p:Patient)-[:HAD_ENCOUNTER]->(e)
       OPTIONAL MATCH (e)-[:TREATED_BY]->(prov:Provider)
       OPTIONAL MATCH (e)-[:AT_ORGANIZATION]->(org:Organization)
       RETURN e.encounter_class AS class, e.description AS description,
              e.start_date AS start_date, e.stop_date AS stop_date,
              e.reason_code AS reason_code, e.reason_description AS reason_description,
              p.patient_id AS patient_id, p.first_name AS first_name, p.last_name AS last_name,
              prov.name AS provider_name, prov.specialty AS provider_specialty,
              org.name AS organization_name`,
      { eid },
    );
    if (!encRow) return { error: `Encounter ${eid} not found` };

    const [conditions, medications, labs, procedures] = await Promise.all([
      q(`MATCH (:Patient)-[r:DIAGNOSED_WITH {encounter_id: $eid}]->(c:ConceptCondition)
         RETURN c.code AS code, c.description AS description, r.start_date AS start_date`,
         { eid }),
      q(`MATCH (:Patient)-[r:PRESCRIBED {encounter_id: $eid}]->(m:ConceptMedication)
         RETURN m.code AS code, m.description AS description,
                r.start_date AS start_date, r.stop_date AS stop_date,
                r.reason_description AS reason`,
         { eid }),
      q(`MATCH (:Patient)-[r:HAS_RESULT {encounter_id: $eid}]->(o:ConceptObservation)
         RETURN o.code AS code, o.description AS description,
                r.value AS value, r.units AS units, r.date AS date`,
         { eid }),
      q(`MATCH (:Patient)-[r:UNDERWENT {encounter_id: $eid}]->(pr:ConceptProcedure)
         RETURN pr.code AS code, pr.description AS description,
                r.start_date AS start_date, r.stop_date AS stop_date,
                r.reason_description AS reason`,
         { eid }),
    ]);

    return {
      encounter_id: eid,
      class: encRow.class,
      description: encRow.description,
      start_date: encRow.start_date,
      stop_date: encRow.stop_date,
      reason: encRow.reason_description,
      patient: encRow.patient_id
        ? { patient_id: encRow.patient_id, name: `${encRow.first_name} ${encRow.last_name}` }
        : null,
      provider: encRow.provider_name
        ? { name: encRow.provider_name, specialty: encRow.provider_specialty }
        : null,
      organization: encRow.organization_name ?? null,
      conditions,
      medications,
      labs,
      procedures,
    };
  },

  async list_treatments_for_condition(args) {
    const condition = String(args.condition ?? "");
    const limit = Math.min(Number(args.limit) || 20, 100);
    if (!condition) return { error: "'condition' is required" };

    // Match by code if condition looks like a SNOMED numeric string, else by desc.
    const byCode = /^\d{5,20}$/.test(condition.trim());
    const condFilter = byCode ? "c.code = $condition" : "LOWER(c.description) CONTAINS LOWER($condition)";

    // Rank by distinct-patient count: clinically more meaningful than raw
    // prescription count (one patient on 10 refills shouldn't dominate over
    // 10 patients each filled once). Plain MATCH (not OPTIONAL) drops TREATS
    // edges that never resulted in a real prescription — they're reason-code
    // derivation noise rather than actual clinical practice.
    const rows = await q(
      `MATCH (m:ConceptMedication)-[:TREATS]->(c:ConceptCondition)
       WHERE ${condFilter}
       MATCH (p:Patient)-[r:PRESCRIBED]->(m)
       WHERE r.reason_code = c.code
       RETURN m.code AS code, m.description AS description,
              c.code AS condition_code, c.description AS condition_description,
              count(DISTINCT p) AS patient_count,
              count(DISTINCT r.start_date) AS distinct_rx_dates
       ORDER BY patient_count DESC, distinct_rx_dates DESC
       LIMIT ${limit}`,
      { condition },
    );

    if (rows.length === 0) {
      return {
        condition_query: condition,
        note: `No TREATS edges found for condition '${condition}'`,
        medications: [],
      };
    }

    return {
      condition_query: condition,
      medications: rows.map((r) => ({
        code: r.code,
        description: r.description,
        condition_code: r.condition_code,
        condition_description: r.condition_description,
        patient_count: Number(r.patient_count),
        distinct_prescription_dates: Number(r.distinct_rx_dates),
      })),
    };
  },

  async rank_conditions_in_cohort(args) {
    const { match, where, params } = buildCohortFilter(args);
    const limit = Math.min(Number(args.limit) || 10, 100);
    // Append the ranking edge + condition node to the existing cohort filter.
    // count(DISTINCT p) gives patient-count per condition (not
    // diagnosis-count, so a patient with two recordings of sinusitis counts
    // once, which is what doctors usually mean by "most common").
    // Exclude SDoH findings but exempt the clinical-findings allow-list so
    // conditions like "Prediabetes (finding)" can still show up in cohort
    // rankings.
    const findingExpr = `(NOT c.description ENDS WITH '(finding)' OR c.description IN [${findingsAllowlistCypher()}])`;
    const findingsFilter = args.include_findings
      ? ""
      : (where ? ` AND ${findingExpr}` : `WHERE ${findingExpr}`);
    const cypher = `${match}
      MATCH (p)-[:DIAGNOSED_WITH]->(c:ConceptCondition)
      ${where}${findingsFilter}
      RETURN c.description AS description, c.code AS code,
             count(DISTINCT p) AS patient_count
      ORDER BY patient_count DESC
      LIMIT ${limit}`;

    const rows = await q(cypher, params);
    return rows.map((r) => ({
      description: r.description,
      code: r.code,
      patient_count: Number(r.patient_count),
    }));
  },
};

export async function executeTool(name: string, args: ToolArgs): Promise<unknown> {
  const fn = executors[name];
  if (!fn) return { error: `Unknown tool: ${name}` };
  const start = metricsEnabled() ? Date.now() : 0;
  try {
    return await fn(args);
  } catch (err) {
    return { error: `Tool ${name} failed: ${(err as Error).message}` };
  } finally {
    if (metricsEnabled()) recordTool(name, Date.now() - start);
  }
}
