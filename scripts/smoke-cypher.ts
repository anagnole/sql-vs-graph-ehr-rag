/**
 * Smoke test the run_cypher executor by issuing the kind of queries the model
 * might write for a few real questions. Validates the schema-in-prompt is
 * sufficient for valid Cypher to actually execute.
 */
import { join } from "node:path";
import { withLock, getConnection } from "../src/api/kuzu-client.js";

process.env.KUZU_DB_PATH = process.env.KUZU_DB_PATH ?? join(import.meta.dirname, "..", ".brainifai/data/kuzu-200");

async function run(name: string, query: string) {
  console.log(`\n=== ${name} ===`);
  console.log(`Q: ${query}`);
  try {
    const rows = await withLock(async () => {
      const c = await getConnection();
      const r = await c.query(query);
      return (await r.getAll()) as Record<string, unknown>[];
    });
    console.log(`  ${rows.length} rows`);
    if (rows.length > 0) {
      const first = JSON.stringify(rows[0]);
      console.log(`  first: ${first.length > 200 ? first.slice(0, 200) + "…" : first}`);
    }
  } catch (e) {
    console.log(`  ERR: ${(e as Error).message}`);
  }
}

async function main() {
  // 1) Patient by id (SL pattern)
  await run("patient lookup",
    `MATCH (p:Patient {patient_id:'000085c1-5b07-25b7-26cc-e0639d7f42d4'}) RETURN p.first_name, p.last_name, p.gender, p.age_years`);

  // 2) Latest HbA1c for a patient (SL trend pattern, single value)
  await run("latest HbA1c",
    `MATCH (p:Patient {patient_id:'000085c1-5b07-25b7-26cc-e0639d7f42d4'})-[r:HAS_RESULT]->(o:ConceptObservation) WHERE o.code='4548-4' RETURN r.value, r.units, r.date ORDER BY r.date DESC LIMIT 1`);

  // 3) Active conditions count (RSN-110 pattern)
  await run("active conditions",
    `MATCH (p:Patient {patient_id:'000085c1-5b07-25b7-26cc-e0639d7f42d4'})-[d:DIAGNOSED_WITH]->(c:ConceptCondition) WHERE d.stop_date IS NULL RETURN c.description ORDER BY c.description`);

  // 4) Cohort count (COH pattern)
  await run("cohort: hyperlipidemia",
    `MATCH (p:Patient)-[d:DIAGNOSED_WITH]->(c:ConceptCondition) WHERE lower(c.description) CONTAINS 'hyperlipidemia' RETURN COUNT(DISTINCT p) AS n`);

  // 5) Multi-hop: DBP at first lisinopril encounter (MH-82 pattern)
  await run("MH-82 — DBP at first lisinopril",
    `MATCH (p:Patient {patient_id:'000085c1-5b07-25b7-26cc-e0639d7f42d4'})-[m:PRESCRIBED]->(med:ConceptMedication) WHERE lower(med.description) CONTAINS 'lisinopril 10' WITH p, m ORDER BY m.start_date LIMIT 1 MATCH (p)-[r:HAS_RESULT]->(o:ConceptObservation) WHERE r.encounter_id = m.encounter_id AND o.code='8462-4' RETURN r.value, r.units, r.date`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
