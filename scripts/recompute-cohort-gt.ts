/**
 * Recompute cohort question ground truth for each tier.
 *
 * Cohort questions ("how many patients have X and Y", "average lab for cohort
 * with condition Z") have answers that depend on the cohort size. The same
 * question has 3 different correct answers — one per tier — so we need to
 * compute each tier's ground truth by querying the tier-specific Kuzu DB.
 *
 * Patient-specific questions (simple-lookup, multi-hop, temporal, reasoning)
 * have stable answers across tiers because they reference specific patients
 * that exist in all 3 tiers (per the first-200 anchor curation).
 *
 * Output: writes `groundTruthByTier: { "200": "...", "2000": "...", "20000": "..." }`
 * onto each cohort question in evaluation-questions-tiered.json. Patient-specific
 * questions are left untouched.
 *
 * Run: npx tsx scripts/recompute-cohort-gt.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import kuzu from "kuzu";
import type { GroundTruthQuestion } from "../src/questions/types.js";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const QUESTIONS_FILE = join(PROJECT_ROOT, "data/generated/evaluation-questions-tiered.json");
const TIERS = ["200", "2000", "20000"] as const;
type Tier = typeof TIERS[number];

interface QuestionWithTierGT extends GroundTruthQuestion {
  groundTruthByTier?: Record<string, string>;
}

// ─── Cypher helpers ──────────────────────────────────────────────────────────

async function queryAll(conn: InstanceType<typeof kuzu.Connection>, cypher: string): Promise<Record<string, unknown>[]> {
  const result = await conn.query(cypher);
  const qr = Array.isArray(result) ? result[0] : result;
  return (await qr.getAll()) as Record<string, unknown>[];
}

function safe(s: string): string {
  return s.replace(/'/g, "''");
}

// ─── Per-category recomputers ────────────────────────────────────────────────

/** Category 1: "How many patients have both X and Y?" */
async function recomputeCoOccurrence(
  conn: InstanceType<typeof kuzu.Connection>,
  condA: string,
  condB: string,
): Promise<string> {
  const rows = await queryAll(
    conn,
    `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c1:ConceptCondition)
     WHERE LOWER(c1.description) CONTAINS LOWER('${safe(condA)}')
     MATCH (p)-[:DIAGNOSED_WITH]->(c2:ConceptCondition)
     WHERE LOWER(c2.description) CONTAINS LOWER('${safe(condB)}')
     RETURN count(DISTINCT p) AS n`,
  );
  return `${rows[0].n} patients`;
}

/** Category 2: "What is the average most-recent <lab> value for patients with <cond>?" */
async function recomputeLabAvg(
  conn: InstanceType<typeof kuzu.Connection>,
  cond: string,
  labCode: string,
): Promise<string> {
  // Get all (patient, lab value, date) tuples for the cohort.
  // Compute most-recent value per patient in JS, then average.
  const rows = await queryAll(
    conn,
    `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c:ConceptCondition)
     WHERE LOWER(c.description) CONTAINS LOWER('${safe(cond)}')
     MATCH (p)-[r:HAS_RESULT]->(o:ConceptObservation)
     WHERE o.code = '${safe(labCode)}' AND r.type = 'numeric'
     RETURN p.patient_id AS pid, r.value AS value, r.date AS date`,
  );

  const latest = new Map<string, { value: number; date: string }>();
  for (const row of rows) {
    const pid = row.pid as string;
    const val = parseFloat(String(row.value ?? ""));
    if (!Number.isFinite(val)) continue;
    const date = String(row.date ?? "");
    const existing = latest.get(pid);
    if (!existing || date > existing.date) latest.set(pid, { value: val, date });
  }

  const values = [...latest.values()].map((v) => v.value);
  if (values.length === 0) return `0 patients (no data)`;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return `${avg.toFixed(2)} (across ${values.length} patients)`;
}

/** Category 3: "How many patients have been prescribed <medication>?" */
async function recomputeMedCount(
  conn: InstanceType<typeof kuzu.Connection>,
  medName: string,
): Promise<string> {
  const rows = await queryAll(
    conn,
    `MATCH (p:Patient)-[:PRESCRIBED]->(m:ConceptMedication)
     WHERE m.description = '${safe(medName)}'
     RETURN count(DISTINCT p) AS n`,
  );
  return `${rows[0].n} patients`;
}

/** Category 4: "What percentage of diabetic patients have a most recent A1C value above 7.0%?" */
async function recomputeA1cPct(
  conn: InstanceType<typeof kuzu.Connection>,
): Promise<string> {
  // Distinct diabetic patient IDs
  const diabeticRows = await queryAll(
    conn,
    `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c:ConceptCondition)
     WHERE LOWER(c.description) CONTAINS 'diabetes'
     RETURN DISTINCT p.patient_id AS pid`,
  );
  const diabeticIds = new Set(diabeticRows.map((r) => r.pid as string));
  if (diabeticIds.size === 0) return `0% (no diabetic patients)`;

  // A1C values for diabetic patients
  const a1cRows = await queryAll(
    conn,
    `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c:ConceptCondition)
     WHERE LOWER(c.description) CONTAINS 'diabetes'
     MATCH (p)-[r:HAS_RESULT]->(o:ConceptObservation)
     WHERE o.code = '4548-4' AND r.type = 'numeric'
     RETURN p.patient_id AS pid, r.value AS value, r.date AS date`,
  );

  const latest = new Map<string, { value: number; date: string }>();
  for (const row of a1cRows) {
    const pid = row.pid as string;
    const val = parseFloat(String(row.value ?? ""));
    if (!Number.isFinite(val)) continue;
    const date = String(row.date ?? "");
    const existing = latest.get(pid);
    if (!existing || date > existing.date) latest.set(pid, { value: val, date });
  }

  let high = 0;
  for (const v of latest.values()) {
    if (v.value > 7.0) high++;
  }
  const pct = ((high / diabeticIds.size) * 100).toFixed(1);
  return `${pct}% (${high} of ${diabeticIds.size} diabetic patients)`;
}

/** Category 4b: Generic percentage threshold */
async function recomputePctThreshold(
  conn: InstanceType<typeof kuzu.Connection>,
  condFilter: string,
  labCode: string,
  threshold: number,
  direction: "above" | "below",
): Promise<string> {
  const condRows = await queryAll(
    conn,
    `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c:ConceptCondition)
     WHERE LOWER(c.description) CONTAINS LOWER('${safe(condFilter)}')
     RETURN DISTINCT p.patient_id AS pid`,
  );
  const condIds = new Set(condRows.map((r) => r.pid as string));
  if (condIds.size === 0) return `0% (no patients with ${condFilter})`;

  const labRows = await queryAll(
    conn,
    `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c:ConceptCondition)
     WHERE LOWER(c.description) CONTAINS LOWER('${safe(condFilter)}')
     MATCH (p)-[r:HAS_RESULT]->(o:ConceptObservation)
     WHERE o.code = '${safe(labCode)}' AND r.type = 'numeric'
     RETURN p.patient_id AS pid, r.value AS value, r.date AS date`,
  );

  const latest = new Map<string, { value: number; date: string }>();
  for (const row of labRows) {
    const pid = row.pid as string;
    const val = parseFloat(String(row.value ?? ""));
    if (!Number.isFinite(val)) continue;
    const date = String(row.date ?? "");
    const existing = latest.get(pid);
    if (!existing || date > existing.date) latest.set(pid, { value: val, date });
  }

  let matchCount = 0;
  for (const v of latest.values()) {
    if (direction === "above" && v.value > threshold) matchCount++;
    if (direction === "below" && v.value < threshold) matchCount++;
  }
  const pct = ((matchCount / condIds.size) * 100).toFixed(1);
  return `${pct}% (${matchCount} of ${condIds.size} patients)`;
}

// Mirror of src/api/tools.ts CLINICAL_FINDINGS_ALLOWLIST. Keep in sync — these
// are findings that are clinical diagnoses, not SDoH, and should appear in
// "most common conditions" answers alongside disorders.
const CLINICAL_FINDINGS_ALLOWLIST_CYPHER = [
  "'Prediabetes (finding)'",
  "'Hypoxemia (finding)'",
  "'Hyperglycemia (finding)'",
  "'Hypoglycemia (finding)'",
  "'Proteinuria (finding)'",
  "'Microalbuminuria (finding)'",
  "'Loss of taste (finding)'",
].join(", ");

/** Category 5b: "What are the 5 most common conditions among <gender> patients?"
 *
 * 2026-04-23 semantics update: use `count(DISTINCT p)` (patient-count) not
 * `count(*)` (record-count), and exclude SDoH findings with the same
 * allow-list as the runtime `rank_conditions_in_cohort` tool. Prior GT
 * numbers were 6–10× higher than the tool's output, which fuzzed all cohort
 * scoring through a false-negative haze.
 */
async function recomputeGenderConditions(
  conn: InstanceType<typeof kuzu.Connection>,
  gender: string,
): Promise<string> {
  // death_date is now a proper DATE column (post-2026-04-22 re-ingest); the
  // old `OR p.death_date = ''` comparison against an empty string errors
  // against DATE. NULL is the only "no death date" representation now.
  const rows = await queryAll(
    conn,
    `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c:ConceptCondition)
     WHERE p.gender = '${safe(gender)}'
       AND p.death_date IS NULL
       AND (NOT c.description ENDS WITH '(finding)'
            OR c.description IN [${CLINICAL_FINDINGS_ALLOWLIST_CYPHER}])
     RETURN c.description AS description, count(DISTINCT p) AS n
     ORDER BY n DESC LIMIT 5`,
  );
  if (rows.length === 0) return "No patients";
  return rows.map((r) => `${r.description} (${r.n})`).join("; ");
}

/** Category 6: "How many patients have been diagnosed with X?" */
async function recomputeCondCount(
  conn: InstanceType<typeof kuzu.Connection>,
  condName: string,
): Promise<string> {
  const rows = await queryAll(
    conn,
    `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c:ConceptCondition)
     WHERE LOWER(c.description) CONTAINS LOWER('${safe(condName)}')
     RETURN count(DISTINCT p) AS n`,
  );
  const n = rows[0].n as number;
  return `${n} ${n === 1 ? "patient" : "patients"}`;
}

/** Category 7: "How many patients have X, Y, and Z?" (triple) */
async function recomputeTripleCoOccurrence(
  conn: InstanceType<typeof kuzu.Connection>,
  condA: string,
  condB: string,
  condC: string,
): Promise<string> {
  const rows = await queryAll(
    conn,
    `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c1:ConceptCondition)
     WHERE LOWER(c1.description) CONTAINS LOWER('${safe(condA)}')
     MATCH (p)-[:DIAGNOSED_WITH]->(c2:ConceptCondition)
     WHERE LOWER(c2.description) CONTAINS LOWER('${safe(condB)}')
     MATCH (p)-[:DIAGNOSED_WITH]->(c3:ConceptCondition)
     WHERE LOWER(c3.description) CONTAINS LOWER('${safe(condC)}')
     RETURN count(DISTINCT p) AS n`,
  );
  const n = rows[0].n as number;
  return `${n} ${n === 1 ? "patient" : "patients"}`;
}

/** Category 8: "How many patients have ever been prescribed X?" (med class, uses CONTAINS) */
async function recomputeMedClassCount(
  conn: InstanceType<typeof kuzu.Connection>,
  keyword: string,
): Promise<string> {
  const rows = await queryAll(
    conn,
    `MATCH (p:Patient)-[:PRESCRIBED]->(m:ConceptMedication)
     WHERE LOWER(m.description) CONTAINS LOWER('${safe(keyword)}')
     RETURN count(DISTINCT p) AS n`,
  );
  const n = rows[0].n as number;
  return `${n} ${n === 1 ? "patient" : "patients"}`;
}

/** Category 9: "What is the average number of encounters for patients with X?" */
async function recomputeAvgEncounters(
  conn: InstanceType<typeof kuzu.Connection>,
  condName: string,
): Promise<string> {
  const rows = await queryAll(
    conn,
    `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c:ConceptCondition)
     WHERE LOWER(c.description) CONTAINS LOWER('${safe(condName)}')
     WITH DISTINCT p
     MATCH (p)-[:HAD_ENCOUNTER]->(e:Encounter)
     RETURN p.patient_id AS pid, count(e) AS enc_count`,
  );
  if (rows.length === 0) return "0 encounters (no patients)";
  const counts = rows.map((r) => r.enc_count as number);
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  return `${avg.toFixed(1)} encounters (across ${counts.length} patients)`;
}

/** Category 10: "What are the 10 most commonly prescribed medications across all patients?" */
async function recomputeTopMeds(
  conn: InstanceType<typeof kuzu.Connection>,
): Promise<string> {
  const rows = await queryAll(
    conn,
    `MATCH (p:Patient)-[:PRESCRIBED]->(m:ConceptMedication)
     RETURN m.description AS description, count(DISTINCT p) AS n
     ORDER BY n DESC LIMIT 10`,
  );
  return rows.map((r) => `${r.description} (${r.n})`).join("; ");
}

/** Category 5: "What are the 5 most common conditions among living patients aged X-Y?" */
async function recomputeAgeGroup(
  conn: InstanceType<typeof kuzu.Connection>,
  ageMin: number,
  ageMax: number,
): Promise<string> {
  // birth_date is DATE (post-2026-04-22 re-ingest). Compare as dates, not
  // strings — the old substring(..., 1, 4) approach errors on a DATE column.
  // Same patient-count + findings-allowlist semantics as
  // recomputeGenderConditions.
  const nowYear = new Date().getFullYear();
  const minBirthYear = nowYear - ageMax; // older bound
  const maxBirthYear = nowYear - ageMin; // younger bound

  const rows = await queryAll(
    conn,
    `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c:ConceptCondition)
     WHERE p.death_date IS NULL
       AND p.birth_date >= DATE('${minBirthYear}-01-01')
       AND p.birth_date <  DATE('${maxBirthYear + 1}-01-01')
       AND (NOT c.description ENDS WITH '(finding)'
            OR c.description IN [${CLINICAL_FINDINGS_ALLOWLIST_CYPHER}])
     RETURN c.description AS description, count(DISTINCT p) AS n
     ORDER BY n DESC LIMIT 5`,
  );

  if (rows.length === 0) return "No patients in age range";
  return rows.map((r) => `${r.description} (${r.n})`).join("; ");
}

// ─── Question parser ─────────────────────────────────────────────────────────

interface ParsedCohort {
  category: number;
  params: Record<string, string | number>;
}

const labMap: Record<string, string> = {
  "Hemoglobin A1c": "4548-4", "A1C": "4548-4",
  "Creatinine": "2160-0",
  "Total Cholesterol": "2093-3",
  "Systolic Blood Pressure": "8480-6", "Systolic BP": "8480-6",
  "eGFR": "33914-3",
  "Body Mass Index": "39156-5",
};

function parseCohortQuestion(q: GroundTruthQuestion): ParsedCohort | null {
  const text = q.question;
  let m;

  // Category 1: "How many patients have both X and Y?"
  m = text.match(/^How many patients have both (.+?) and (.+?)\?$/);
  if (m) return { category: 1, params: { condA: m[1], condB: m[2] } };

  // Category 2: "What is the average most-recent X value for patients with Y?"
  m = text.match(/^What is the average most-recent (.+?) value for patients with (.+?)\?$/);
  if (m) {
    const labCode = labMap[m[1]];
    if (!labCode) return null;
    return { category: 2, params: { cond: m[2], labCode, labName: m[1] } };
  }

  // Category 3: "How many patients have been prescribed X?" (exact med name)
  m = text.match(/^How many patients have been prescribed (.+?)\?$/);
  if (m) return { category: 3, params: { medName: m[1] } };

  // Category 4: Generic pct threshold: "What percentage of patients with X have a most recent Y value above/below Z?"
  m = text.match(/percentage of patients with (.+?) have a most recent (.+?) value (above|below) ([\d.]+)/);
  if (m) {
    const labCode = labMap[m[2]];
    if (!labCode) return null;
    return { category: 41, params: { condFilter: m[1].toLowerCase(), labCode, threshold: parseFloat(m[4]), direction: m[3] } };
  }
  // Legacy: "What percentage of diabetic patients..."
  if (/percentage of diabetic patients.*A1C.*7\.0/.test(text)) {
    return { category: 4, params: {} };
  }

  // Category 5: "What are the 5 most common conditions among living patients aged X-Y?"
  m = text.match(/^What are the 5 most common conditions among living patients aged (\d+)-(\d+)\?$/);
  if (m) return { category: 5, params: { ageMin: parseInt(m[1]), ageMax: parseInt(m[2]) } };
  m = text.match(/^What are the 5 most common conditions among living patients aged (\d+)\+\?$/);
  if (m) return { category: 5, params: { ageMin: parseInt(m[1]), ageMax: 200 } };

  // Category 5b: "What are the 5 most common conditions among male/female patients?"
  m = text.match(/^What are the 5 most common conditions among (male|female) patients\?$/);
  if (m) return { category: 51, params: { gender: m[1] === "male" ? "M" : "F" } };

  // Category 6: "How many patients have been diagnosed with X?"
  m = text.match(/^How many patients have been diagnosed with (.+?)\?$/);
  if (m) return { category: 6, params: { condName: m[1] } };

  // Category 7: "How many patients have X, Y, and Z?" (triple)
  m = text.match(/^How many patients have (.+?), (.+?), and (.+?)\?$/);
  if (m) return { category: 7, params: { condA: m[1], condB: m[2], condC: m[3] } };

  // Category 8: "How many patients have ever been prescribed X?" (med class, uses CONTAINS)
  m = text.match(/^How many patients have ever been prescribed (.+?)\?$/);
  if (m) return { category: 8, params: { keyword: m[1].toLowerCase().replace(/^a /, "") } };

  // Category 9: "What is the average number of encounters for patients with X?"
  m = text.match(/^What is the average number of encounters for patients with (.+?)\?$/);
  if (m) return { category: 9, params: { condName: m[1] } };

  // Category 10: "What are the 10 most commonly prescribed medications across all patients?"
  if (/most commonly prescribed medications/.test(text)) {
    return { category: 10, params: {} };
  }

  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const questions: QuestionWithTierGT[] = JSON.parse(readFileSync(QUESTIONS_FILE, "utf-8"));
  const cohortQs = questions.filter((q) => q.type === "cohort");
  console.log(`Loaded ${questions.length} questions, ${cohortQs.length} cohort.\n`);

  // Parse all cohort questions first to fail fast on unknown templates
  const parsed = new Map<string, ParsedCohort>();
  const unparsed: string[] = [];
  for (const q of cohortQs) {
    const p = parseCohortQuestion(q);
    if (p) parsed.set(q.id, p);
    else unparsed.push(`${q.id}: ${q.question}`);
  }

  if (unparsed.length > 0) {
    console.error("⚠ Could not parse the following cohort questions:");
    for (const u of unparsed) console.error("  " + u);
    console.error("\nAdd templates to parseCohortQuestion() and retry.");
    process.exit(1);
  }
  console.log(`Parsed ${parsed.size} cohort questions across categories.\n`);

  // Compute ground truth per tier
  for (const tier of TIERS) {
    console.log(`── tier-${tier} ──`);
    const dbPath = join(PROJECT_ROOT, ".brainifai", "data", `kuzu-${tier}`);
    const db = new kuzu.Database(dbPath, 0, true, true);
    const conn = new kuzu.Connection(db);

    for (const q of cohortQs) {
      const p = parsed.get(q.id)!;
      let answer: string;
      try {
        switch (p.category) {
          case 1:
            answer = await recomputeCoOccurrence(conn, p.params.condA as string, p.params.condB as string);
            break;
          case 2:
            answer = await recomputeLabAvg(conn, p.params.cond as string, p.params.labCode as string);
            break;
          case 3:
            answer = await recomputeMedCount(conn, p.params.medName as string);
            break;
          case 4:
            answer = await recomputeA1cPct(conn);
            break;
          case 41:
            answer = await recomputePctThreshold(conn, p.params.condFilter as string, p.params.labCode as string, p.params.threshold as number, p.params.direction as "above" | "below");
            break;
          case 5:
            answer = await recomputeAgeGroup(conn, p.params.ageMin as number, p.params.ageMax as number);
            break;
          case 51:
            answer = await recomputeGenderConditions(conn, p.params.gender as string);
            break;
          case 6:
            answer = await recomputeCondCount(conn, p.params.condName as string);
            break;
          case 7:
            answer = await recomputeTripleCoOccurrence(conn, p.params.condA as string, p.params.condB as string, p.params.condC as string);
            break;
          case 8:
            answer = await recomputeMedClassCount(conn, p.params.keyword as string);
            break;
          case 9:
            answer = await recomputeAvgEncounters(conn, p.params.condName as string);
            break;
          case 10:
            answer = await recomputeTopMeds(conn);
            break;
          default:
            answer = `ERROR: Unknown category ${p.category}`;
        }
      } catch (err) {
        answer = `ERROR: ${(err as Error).message}`;
      }

      // Mutate the question object — find the original in the questions array
      const original = questions.find((qq) => qq.id === q.id)!;
      if (!original.groundTruthByTier) original.groundTruthByTier = {};
      original.groundTruthByTier[tier] = answer;

      console.log(`  ${q.id}: ${answer}`);
    }

    await db.close();
    console.log();
  }

  writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2));
  console.log(`✓ Wrote per-tier ground truth to ${QUESTIONS_FILE}`);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
