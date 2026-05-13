import kuzu from 'kuzu';
import { join } from 'node:path';

const dbPath = process.argv[2] ?? join(process.cwd(), '.brainifai/data/kuzu-200');
const patientId = process.argv[3] ?? '000a359a-408b-1d70-fcd5-4189096a9e29';

const db = new kuzu.Database(dbPath, 0, true, true);
const conn = new kuzu.Connection(db);

async function q(query: string) {
  const res = await conn.query(query);
  const rows = await res.getAll();
  return rows;
}

console.log(`DB: ${dbPath}`);
console.log(`Patient: ${patientId}\n`);

console.log('1. Patient exists?');
console.log(await q(`MATCH (p:Patient {patient_id: '${patientId}'}) RETURN p.patient_id, p.first_name, p.last_name, p.birth_date`));

console.log('\n2. HAS_RESULT edges count:');
console.log(await q(`MATCH (p:Patient {patient_id: '${patientId}'})-[r:HAS_RESULT]->(o) RETURN count(*) AS total`));

console.log('\n3. Distinct observation codes for this patient:');
console.log(await q(`MATCH (p:Patient {patient_id: '${patientId}'})-[r:HAS_RESULT]->(o:ConceptObservation) RETURN DISTINCT o.code, o.description LIMIT 20`));

console.log('\n4. Any Cholesterol-related obs for this patient (LIKE match):');
console.log(await q(`MATCH (p:Patient {patient_id: '${patientId}'})-[r:HAS_RESULT]->(o:ConceptObservation) WHERE LOWER(o.description) CONTAINS 'cholesterol' RETURN o.code, o.description, r.value, r.units, r.date ORDER BY r.date DESC`));

console.log('\n5. Total patients in DB:');
console.log(await q(`MATCH (p:Patient) RETURN count(*) AS total`));

console.log('\n6. First 5 patient IDs in DB:');
console.log(await q(`MATCH (p:Patient) RETURN p.patient_id ORDER BY p.patient_id LIMIT 5`));

console.log('\n7. Is 2093-3 present as a ConceptObservation at all?');
console.log(await q(`MATCH (o:ConceptObservation {code: '2093-3'}) RETURN o.code, o.description`));

console.log('\n8. How many patients have 2093-3 readings?');
console.log(await q(`MATCH (p:Patient)-[r:HAS_RESULT]->(o:ConceptObservation {code: '2093-3'}) RETURN count(DISTINCT p) AS n_patients, count(*) AS n_readings`));
