/**
 * SQL+FTS adapter — same 7 functions as SqlAdapter but uses PostgreSQL
 * tsvector/tsquery for text matching instead of ILIKE.
 *
 * Only searchPatients and findCohort differ from the base SQL adapter.
 * The rest delegate directly.
 */

import pg from 'pg';
import { SqlAdapter, type PatientRecord } from './adapter.js';

export class SqlFtsAdapter extends SqlAdapter {
  private ftsPool: pg.Pool;

  constructor(pool: pg.Pool) {
    super(pool);
    this.ftsPool = pool;
  }

  // ─── 1. Search Patients (FTS) ────────────────────────────────────────────

  override async searchPatients(query: string, limit = 20): Promise<PatientRecord[]> {
    // Convert search terms to tsquery format: "John Boston" → "John & Boston"
    const terms = query.trim().split(/\s+/).filter(Boolean);
    const tsquery = terms.map(t => t.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' & ');

    if (!tsquery) return [];

    const { rows } = await this.ftsPool.query(
      `SELECT patient_id, first_name, last_name, birth_date, death_date,
              gender, race, ethnicity, marital_status, city, state, zip,
              ts_rank(fts, to_tsquery('english', $1)) AS rank
       FROM patient
       WHERE fts @@ to_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT $2`,
      [tsquery, limit],
    );
    return rows;
  }

  // ─── 7. Cohort Discovery (FTS for text matching) ────────────────────────

  override async findCohort(opts: {
    conditions?: string[];
    medications?: string[];
    ageRange?: [number, number];
    gender?: string;
  }): Promise<PatientRecord[]> {
    const params: unknown[] = [];
    const joins: string[] = [];
    const filters: string[] = [];

    if (opts.conditions) {
      for (let i = 0; i < opts.conditions.length; i++) {
        const alias = `c${i}`;
        joins.push(`JOIN condition ${alias} ON ${alias}.patient_id = p.patient_id`);
        const terms = opts.conditions[i].trim().split(/\s+/)
          .map(t => t.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' & ');
        params.push(terms);
        filters.push(`${alias}.fts @@ to_tsquery('english', $${params.length})`);
      }
    }

    if (opts.medications) {
      for (let i = 0; i < opts.medications.length; i++) {
        const alias = `m${i}`;
        joins.push(`JOIN medication ${alias} ON ${alias}.patient_id = p.patient_id`);
        const terms = opts.medications[i].trim().split(/\s+/)
          .map(t => t.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' & ');
        params.push(terms);
        filters.push(`${alias}.fts @@ to_tsquery('english', $${params.length})`);
      }
    }

    if (opts.gender) {
      params.push(opts.gender);
      filters.push(`p.gender = $${params.length}`);
    }

    // age_years is indexed and precomputed at ingest — filter in SQL.
    if (opts.ageRange) {
      params.push(opts.ageRange[0]);
      filters.push(`p.age_years >= $${params.length}`);
      params.push(opts.ageRange[1]);
      filters.push(`p.age_years <= $${params.length}`);
    }

    const whereClause = filters.length > 0 ? 'WHERE ' + filters.join(' AND ') : '';

    const { rows } = await this.ftsPool.query(
      `SELECT DISTINCT p.patient_id, p.first_name, p.last_name, p.birth_date,
              p.death_date, p.gender, p.race, p.ethnicity,
              p.marital_status, p.city, p.state, p.zip
       FROM patient p
       ${joins.join('\n')}
       ${whereClause}
       LIMIT 100`,
      params,
    );

    return rows;
  }
}
