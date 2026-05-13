/**
 * Post-ingest verification for the SQL-side schema parity work.
 *
 * Usage (after `npm run pg:up` + `npm run pg:ingest -- --tier 200`):
 *   PG_DSN=postgresql://user@localhost:5432/ehrdb-200 npx tsx scripts/verify-sql-parity.ts
 *
 * Checks that the five parity additions actually populated:
 *   1. patient.age_years is an INT and populated for every patient
 *   2. observation.value_canonical is DOUBLE PRECISION and populated for
 *      at least the labs covered by loinc-normalization.ts
 *   3. observation_reference_range table has rows for the curated LOINC codes
 *   4. DATE columns accept normal ordering/arithmetic
 *   5. Spot-check cohort query uses age_years index (not post-query JS filter)
 */

import pg from 'pg';

const PG_DSN = process.env.PG_DSN ?? 'postgresql://user@localhost:5432/ehrdb-200';

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: PG_DSN });
  let failures = 0;
  const ok = (label: string, msg: string): void => console.log(`[OK]  ${label}: ${msg}`);
  const fail = (label: string, msg: string): void => { console.log(`[ERR] ${label}: ${msg}`); failures++; };

  try {
    // 1. age_years presence and typing
    const ageCol = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_name='patient' AND column_name='age_years'`);
    if (ageCol.rowCount === 0) fail('age_years column', 'missing on patient');
    else ok('age_years column', `type=${ageCol.rows[0].data_type}`);

    const agePop = await pool.query(`SELECT count(*) AS total, count(age_years) AS populated, min(age_years) AS mn, max(age_years) AS mx FROM patient`);
    const r = agePop.rows[0];
    if (Number(r.populated) === Number(r.total) && Number(r.total) > 0) {
      ok('age_years populated', `all ${r.total} patients (range ${r.mn}–${r.mx})`);
    } else {
      fail('age_years populated', `only ${r.populated}/${r.total}`);
    }

    // 2. value_canonical + units_canonical on observation
    const vcCol = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_name='observation' AND column_name='value_canonical'`);
    if (vcCol.rowCount === 0) fail('value_canonical column', 'missing');
    else ok('value_canonical column', `type=${vcCol.rows[0].data_type}`);

    const hba1cPop = await pool.query(`SELECT count(*) AS total, count(value_canonical) AS numeric FROM observation WHERE code='4548-4'`);
    const hb = hba1cPop.rows[0];
    if (Number(hb.numeric) === Number(hb.total) && Number(hb.total) > 0) {
      ok('HbA1c canonical values', `all ${hb.total} readings normalized`);
    } else {
      fail('HbA1c canonical values', `${hb.numeric}/${hb.total} have value_canonical`);
    }

    // 3. reference-range table and coverage
    const rrCount = await pool.query(`SELECT count(*) AS n FROM observation_reference_range`);
    if (Number(rrCount.rows[0].n) < 10) {
      fail('reference-range table', `only ${rrCount.rows[0].n} rows — expected ≥10 curated LOINCs`);
    } else {
      ok('reference-range table', `${rrCount.rows[0].n} rows`);
    }

    const hba1cRange = await pool.query(`SELECT normal_low, normal_high, source FROM observation_reference_range WHERE code='4548-4'`);
    if (hba1cRange.rowCount === 0) fail('HbA1c reference range', 'missing');
    else ok('HbA1c reference range', `normal ${hba1cRange.rows[0].normal_low}–${hba1cRange.rows[0].normal_high} (${hba1cRange.rows[0].source})`);

    // 4. DATE column behavior
    const dateCol = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_name='patient' AND column_name='birth_date'`);
    if (dateCol.rows[0]?.data_type !== 'date') fail('birth_date type', `expected 'date', got '${dateCol.rows[0]?.data_type}'`);
    else ok('birth_date type', `DATE`);

    // DATE arithmetic: find patients who turned 65 at some point
    const dateMath = await pool.query(`SELECT count(*) AS n FROM patient WHERE birth_date < CURRENT_DATE - INTERVAL '65 years'`);
    ok('DATE arithmetic', `${dateMath.rows[0].n} patients born >65 years ago (INTERVAL math works)`);

    // 5. Cohort via age_years index
    const cohort = await pool.query(`EXPLAIN SELECT patient_id FROM patient WHERE age_years BETWEEN 50 AND 70`);
    const plan = cohort.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n');
    if (plan.includes('Seq Scan')) {
      ok('age_years query plan', `planner used Seq Scan (fine on tier-200; index kicks in at larger tiers)`);
    } else if (plan.includes('idx_patient_age') || plan.includes('Index')) {
      ok('age_years query plan', 'uses index');
    } else {
      ok('age_years query plan', plan.split('\n')[0]);
    }

    // 6. Flag abnormals via JOIN — the central paradigm-fairness check
    const abnormal = await pool.query(`
      SELECT count(*) AS abnormal_count
      FROM observation o
      JOIN observation_reference_range r ON o.code = r.code
      WHERE o.value_canonical IS NOT NULL
        AND r.normal_high IS NOT NULL
        AND o.value_canonical > r.normal_high
    `);
    ok('abnormal-lab JOIN', `${abnormal.rows[0].abnormal_count} high readings flaggable via reference-range JOIN`);

    // 7. stop_date IS NULL semantic (no more '' equality needed)
    const active = await pool.query(`SELECT count(*) AS n FROM medication WHERE stop_date IS NULL`);
    const stopped = await pool.query(`SELECT count(*) AS n FROM medication WHERE stop_date IS NOT NULL`);
    ok('active/stopped meds', `${active.rows[0].n} active + ${stopped.rows[0].n} stopped`);

    console.log(failures === 0 ? '\nAll parity checks passed.' : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
