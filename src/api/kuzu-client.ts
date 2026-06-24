import kuzu from "kuzu";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Subgraph, SubgraphNode, SubgraphEdge, SearchResult } from "./types.js";
import { recordKuzu, metricsEnabled } from "./metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.resolve(__dirname, "../../.brainifai/data/kuzu");

// Resolved lazily so KUZU_DB_PATH env vars set after module import (e.g. in
// run.ts's main(), or in debug scripts that assign before awaiting) are honored.
function resolveDbPath(): string {
  return process.env.KUZU_DB_PATH
    ? path.resolve(process.env.KUZU_DB_PATH)
    : DEFAULT_DB_PATH;
}

let db: kuzu.Database | null = null;
let conn: kuzu.Connection | null = null;

// Kuzu connections are not thread-safe — serialize all queries
let queryLock: Promise<unknown> = Promise.resolve();

export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = queryLock;
  let resolve: () => void;
  queryLock = new Promise<void>((r) => { resolve = r; });

  if (!metricsEnabled()) {
    return prev.then(fn).finally(() => resolve!());
  }

  // Instrumented path: capture lock wait time vs actual query time separately
  const enqueuedAt = Date.now();
  return prev
    .then(async () => {
      const startedAt = Date.now();
      const lockWaitMs = startedAt - enqueuedAt;
      try {
        return await fn();
      } finally {
        recordKuzu(lockWaitMs, Date.now() - startedAt);
      }
    })
    .finally(() => resolve!());
}

// Primary key per node type
const PK: Record<string, string> = {
  Patient: "patient_id",
  Encounter: "encounter_id",
  ConceptCondition: "code",
  ConceptMedication: "code",
  ConceptObservation: "code",
  ConceptProcedure: "code",
  Provider: "provider_id",
  Organization: "organization_id",
};

export async function getConnection(): Promise<kuzu.Connection> {
  if (conn) return conn;
  const dbPath = resolveDbPath();
  db = new kuzu.Database(dbPath, 0, true, true);
  conn = new kuzu.Connection(db);
  await conn.query("LOAD EXTENSION fts");
  return conn;
}

export async function closeConnection(): Promise<void> {
  conn = null;
  if (db) {
    await db.close();
    db = null;
  }
}

// DATE columns come back as JS Date objects. Normalize to YYYY-MM-DD strings so
// UI/API consumers see stable shapes regardless of schema typing.
function normalizeDates(row: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v instanceof Date) row[k] = v.toISOString().slice(0, 10);
  }
  return row;
}

async function q(c: kuzu.Connection, cypher: string): Promise<Record<string, unknown>[]> {
  return withLock(async () => {
    const result = await c.query(cypher);
    return ((await result.getAll()) as Record<string, unknown>[]).map(normalizeDates);
  });
}

function nodeLabel(type: string, row: Record<string, unknown>): string {
  switch (type) {
    case "Patient":
      return `${row.fn ?? row.first_name ?? ""} ${row.ln ?? row.last_name ?? ""}`.trim() || String(row.patient_id ?? "");
    case "Provider":
      return String(row.mname ?? row.name ?? row.provider_id ?? "");
    case "Organization":
      return String(row.mname ?? row.name ?? row.organization_id ?? "");
    default:
      // Concept nodes and encounters
      return String(row.mdescription ?? row.description ?? row.code ?? "");
  }
}

// Date filter clause for a relationship variable 'r' — returns empty string if no filter
function relDateFilter(rel: string, dateFrom?: string, dateTo?: string): string {
  // Map relationship types to their date column
  const dateCol: Record<string, string> = {
    DIAGNOSED_WITH: "start_date",
    PRESCRIBED: "start_date",
    HAS_RESULT: "date",
    UNDERWENT: "start_date",
  };
  const col = dateCol[rel];
  if (!col) return ""; // No date filtering for non-clinical rels
  const parts: string[] = [];
  if (dateFrom) parts.push(`r.${col} >= '${dateFrom}'`);
  if (dateTo) parts.push(`r.${col} <= '${dateTo}'`);
  return parts.length > 0 ? " AND " + parts.join(" AND ") : "";
}

export async function neighborhoodQuery(
  nodeId: string,
  nodeType: string,
  maxNodes = 30,
  dateFrom?: string,
  dateTo?: string,
): Promise<Subgraph> {
  const c = await getConnection();
  const nodes: SubgraphNode[] = [];
  const edges: SubgraphEdge[] = [];
  const seen = new Set<string>();
  const safeId = nodeId.replace(/'/g, "''");
  const pk = PK[nodeType] ?? "code";

  // Get center node label
  let centerLabel = nodeId;
  if (nodeType === "Patient") {
    const rows = await q(c, `MATCH (n:Patient {patient_id: '${safeId}'}) RETURN n.first_name AS fn, n.last_name AS ln`);
    if (rows.length > 0) centerLabel = `${rows[0].fn} ${rows[0].ln}`;
  } else {
    const labelCol = nodeType === "Provider" || nodeType === "Organization" ? "name" : "description";
    const rows = await q(c, `MATCH (n:${nodeType} {${pk}: '${safeId}'}) RETURN n.${labelCol} AS lbl`);
    if (rows.length > 0) centerLabel = rows[0].lbl as string ?? nodeId;
  }

  nodes.push({ id: nodeId, type: nodeType, label: centerLabel });
  seen.add(nodeId);

  // Get 1-hop neighbors — balanced across relationship types
  // Query each relationship type separately with a per-type limit to avoid one type dominating
  const relTypes = nodeType === "Patient"
    ? ["DIAGNOSED_WITH", "PRESCRIBED", "HAS_RESULT", "UNDERWENT", "HAD_ENCOUNTER"]
    : nodeType === "Encounter"
    ? ["TREATED_BY", "AT_ORGANIZATION", "REASON_FOR"]
    : nodeType === "Organization"
    ? ["AFFILIATED_WITH"] // Only show providers, not 1000s of encounters
    : nodeType === "Provider"
    ? ["AFFILIATED_WITH"]
    : null; // For concept nodes, just get all neighbors

  let neighborRows: Record<string, unknown>[];
  if (relTypes) {
    const perType = Math.max(3, Math.floor(maxNodes / relTypes.length));
    const allRows: Record<string, unknown>[] = [];
    for (const rel of relTypes) {
      const dateWhere = relDateFilter(rel, dateFrom, dateTo);
      const rows = await q(c,
        `MATCH (n:${nodeType} {${pk}: '${safeId}'})-[r:${rel}]-(m)
         WHERE true${dateWhere}
         RETURN label(m) AS mtype, label(r) AS rtype,
                m.description AS mdescription, m.name AS mname,
                m.first_name AS fn, m.last_name AS ln, m.code AS mcode,
                m.patient_id AS m_patient_id, m.encounter_id AS m_encounter_id,
                m.provider_id AS m_provider_id, m.organization_id AS m_organization_id
         LIMIT ${perType}`);
      allRows.push(...rows);
    }
    neighborRows = allRows;
  } else {
    neighborRows = await q(c,
      `MATCH (n:${nodeType} {${pk}: '${safeId}'})-[r]-(m)
       RETURN label(m) AS mtype, label(r) AS rtype,
              m.description AS mdescription, m.name AS mname,
              m.first_name AS fn, m.last_name AS ln, m.code AS mcode,
              m.patient_id AS m_patient_id, m.encounter_id AS m_encounter_id,
              m.provider_id AS m_provider_id, m.organization_id AS m_organization_id
       LIMIT ${maxNodes}`);
  }

  for (const r of neighborRows) {
    const mtype = r.mtype as string;
    const rtype = r.rtype as string;

    // Determine the neighbor's ID from its primary key
    const neighborPk = PK[mtype];
    let mid: string | null = null;
    if (neighborPk === "code") mid = r.mcode as string;
    else if (neighborPk === "patient_id") mid = r.m_patient_id as string;
    else if (neighborPk === "encounter_id") mid = r.m_encounter_id as string;
    else if (neighborPk === "provider_id") mid = r.m_provider_id as string;
    else if (neighborPk === "organization_id") mid = r.m_organization_id as string;
    if (!mid) continue;

    // Build label
    let label: string;
    if (r.fn && r.ln) label = `${r.fn} ${r.ln}`;
    else label = (r.mdescription as string) ?? (r.mname as string) ?? mid;

    if (!seen.has(mid)) {
      nodes.push({ id: mid, type: mtype, label });
      seen.add(mid);
    }
    edges.push({ source: nodeId, target: mid, type: rtype });
  }

  return { nodes, edges };
}

export async function searchNodes(
  query: string,
  limit = 10,
): Promise<SearchResult[]> {
  const c = await getConnection();
  const results: SearchResult[] = [];
  const safeQ = query.trim().replace(/'/g, "''");
  if (!safeQ) return results;

  // Search patients
  try {
    const rows = await q(c,
      `CALL QUERY_FTS_INDEX('Patient', 'patient_fts', '${safeQ}')
       RETURN node.patient_id AS id, node.first_name AS fn, node.last_name AS ln, score
       ORDER BY score DESC LIMIT ${limit}`);
    for (const r of rows) {
      results.push({ id: r.id as string, type: "Patient", label: `${r.fn} ${r.ln}`, score: r.score as number });
    }
  } catch (e) { console.error("[graph search] patient FTS error:", e); }

  // Search concept conditions — naturally deduplicated (289 nodes)
  try {
    const rows = await q(c,
      `CALL QUERY_FTS_INDEX('ConceptCondition', 'condition_fts', '${safeQ}')
       RETURN node.code AS id, node.description AS description, score
       ORDER BY score DESC LIMIT ${limit}`);
    for (const r of rows) {
      results.push({ id: r.id as string, type: "ConceptCondition", label: r.description as string, score: r.score as number });
    }
  } catch (e) { console.error("[graph search] condition FTS error:", e); }

  // Search concept medications
  try {
    const rows = await q(c,
      `CALL QUERY_FTS_INDEX('ConceptMedication', 'medication_fts', '${safeQ}')
       RETURN node.code AS id, node.description AS description, score
       ORDER BY score DESC LIMIT ${limit}`);
    for (const r of rows) {
      results.push({ id: r.id as string, type: "ConceptMedication", label: r.description as string, score: r.score as number });
    }
  } catch (e) { console.error("[graph search] medication FTS error:", e); }

  // Search concept observations (labs/vitals)
  try {
    const rows = await q(c,
      `CALL QUERY_FTS_INDEX('ConceptObservation', 'observation_fts', '${safeQ}')
       RETURN node.code AS id, node.description AS description, score
       ORDER BY score DESC LIMIT ${limit}`);
    for (const r of rows) {
      results.push({ id: r.id as string, type: "ConceptObservation", label: r.description as string, score: r.score as number });
    }
  } catch (e) { console.error("[graph search] observation FTS error:", e); }

  // Search concept procedures
  try {
    const rows = await q(c,
      `CALL QUERY_FTS_INDEX('ConceptProcedure', 'procedure_fts', '${safeQ}')
       RETURN node.code AS id, node.description AS description, score
       ORDER BY score DESC LIMIT ${limit}`);
    for (const r of rows) {
      results.push({ id: r.id as string, type: "ConceptProcedure", label: r.description as string, score: r.score as number });
    }
  } catch (e) { console.error("[graph search] procedure FTS error:", e); }

  results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return results.slice(0, limit);
}

export async function getNodeCard(
  nodeId: string,
  nodeType: string,
  dateFrom?: string,
  dateTo?: string,
): Promise<Record<string, unknown>> {
  const c = await getConnection();
  const safeId = nodeId.replace(/'/g, "''");

  // Date filters per relationship type (different date column names)
  function dateClauses(col: string): string {
    const parts: string[] = [];
    if (dateFrom) parts.push(`r.${col} >= '${dateFrom}'`);
    if (dateTo) parts.push(`r.${col} <= '${dateTo}'`);
    return parts.length > 0 ? " AND " + parts.join(" AND ") : "";
  }
  const encDateParts: string[] = [];
  if (dateFrom) encDateParts.push(`e.start_date >= '${dateFrom}'`);
  if (dateTo) encDateParts.push(`e.start_date <= '${dateTo}'`);
  const encDateWhere = encDateParts.length > 0 ? " AND " + encDateParts.join(" AND ") : "";

  switch (nodeType) {
    case "Patient": {
      const [patient] = await q(c,
        `MATCH (p:Patient {patient_id: '${safeId}'})
         RETURN p.first_name AS first_name, p.last_name AS last_name,
                p.birth_date AS birth_date, p.death_date AS death_date,
                p.gender AS gender, p.race AS race, p.city AS city, p.state AS state`);
      if (!patient) return { type: nodeType, error: "Not found" };

      const [condCount] = await q(c,
        `MATCH (p:Patient {patient_id: '${safeId}'})-[r:DIAGNOSED_WITH]->(c:ConceptCondition)
         WHERE true${dateClauses("start_date")}
         RETURN count(c) AS cnt`);
      const [medCount] = await q(c,
        `MATCH (p:Patient {patient_id: '${safeId}'})-[r:PRESCRIBED]->(m:ConceptMedication)
         WHERE true${dateClauses("start_date")}
         RETURN count(m) AS cnt`);
      const [encCount] = await q(c,
        `MATCH (p:Patient {patient_id: '${safeId}'})-[:HAD_ENCOUNTER]->(e:Encounter)
         WHERE true${encDateWhere}
         RETURN count(e) AS cnt`);

      // Active conditions within date range
      const activeConds = await q(c,
        `MATCH (p:Patient {patient_id: '${safeId}'})-[r:DIAGNOSED_WITH]->(c:ConceptCondition)
         WHERE r.stop_date IS NULL${dateClauses("start_date")}
         RETURN c.description AS description LIMIT 5`);

      // Active medications within date range
      const activeMeds = await q(c,
        `MATCH (p:Patient {patient_id: '${safeId}'})-[r:PRESCRIBED]->(m:ConceptMedication)
         WHERE r.stop_date IS NULL${dateClauses("start_date")}
         RETURN m.description AS description LIMIT 5`);

      const age = patient.birth_date
        ? Math.floor((Date.now() - new Date(patient.birth_date as string).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
        : null;

      return {
        type: "Patient",
        name: `${patient.first_name} ${patient.last_name}`,
        age,
        gender: patient.gender,
        race: patient.race,
        location: `${patient.city}, ${patient.state}`,
        alive: !patient.death_date,
        conditionCount: (condCount?.cnt as number) ?? 0,
        medicationCount: (medCount?.cnt as number) ?? 0,
        encounterCount: (encCount?.cnt as number) ?? 0,
        activeConditions: activeConds.map(r => r.description as string),
        activeMedications: activeMeds.map(r => r.description as string),
      };
    }

    case "ConceptCondition": {
      const [node] = await q(c,
        `MATCH (c:ConceptCondition {code: '${safeId}'})
         RETURN c.description AS description, c.system AS system, c.code AS code`);
      if (!node) return { type: nodeType, error: "Not found" };

      const [patCount] = await q(c,
        `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c:ConceptCondition {code: '${safeId}'})
         RETURN count(DISTINCT p) AS cnt`);
      const treatments = await q(c,
        `MATCH (m:ConceptMedication)-[:TREATS]->(c:ConceptCondition {code: '${safeId}'})
         RETURN m.description AS description LIMIT 5`);
      const complications = await q(c,
        `MATCH (comp:ConceptCondition)-[:COMPLICATION_OF]->(c:ConceptCondition {code: '${safeId}'})
         RETURN comp.description AS description LIMIT 5`);

      return {
        type: "Condition",
        description: node.description,
        code: node.code,
        system: node.system,
        patientCount: (patCount?.cnt as number) ?? 0,
        treatments: treatments.map(r => r.description as string),
        complications: complications.map(r => r.description as string),
      };
    }

    case "ConceptMedication": {
      const [node] = await q(c,
        `MATCH (m:ConceptMedication {code: '${safeId}'})
         RETURN m.description AS description, m.code AS code`);
      if (!node) return { type: nodeType, error: "Not found" };

      const [patCount] = await q(c,
        `MATCH (p:Patient)-[:PRESCRIBED]->(m:ConceptMedication {code: '${safeId}'})
         RETURN count(DISTINCT p) AS cnt`);
      const treatsConditions = await q(c,
        `MATCH (m:ConceptMedication {code: '${safeId}'})-[:TREATS]->(c:ConceptCondition)
         RETURN c.description AS description LIMIT 5`);

      return {
        type: "Medication",
        description: node.description,
        code: node.code,
        patientCount: (patCount?.cnt as number) ?? 0,
        treatsConditions: treatsConditions.map(r => r.description as string),
      };
    }

    case "ConceptObservation": {
      const [node] = await q(c,
        `MATCH (o:ConceptObservation {code: '${safeId}'})
         RETURN o.description AS description, o.code AS code, o.category AS category,
                o.units AS units, o.type AS type`);
      if (!node) return { type: nodeType, error: "Not found" };

      const [patCount] = await q(c,
        `MATCH (p:Patient)-[:HAS_RESULT]->(o:ConceptObservation {code: '${safeId}'})
         RETURN count(DISTINCT p) AS cnt`);

      return {
        type: "Observation",
        description: node.description,
        code: node.code,
        category: node.category,
        units: node.units,
        valueType: node.type,
        patientCount: (patCount?.cnt as number) ?? 0,
      };
    }

    case "ConceptProcedure": {
      const [node] = await q(c,
        `MATCH (pr:ConceptProcedure {code: '${safeId}'})
         RETURN pr.description AS description, pr.code AS code, pr.system AS system`);
      if (!node) return { type: nodeType, error: "Not found" };

      const [patCount] = await q(c,
        `MATCH (p:Patient)-[:UNDERWENT]->(pr:ConceptProcedure {code: '${safeId}'})
         RETURN count(DISTINCT p) AS cnt`);
      const indications = await q(c,
        `MATCH (pr:ConceptProcedure {code: '${safeId}'})-[:INDICATED_BY]->(c:ConceptCondition)
         RETURN c.description AS description LIMIT 5`);

      return {
        type: "Procedure",
        description: node.description,
        code: node.code,
        system: node.system,
        patientCount: (patCount?.cnt as number) ?? 0,
        indications: indications.map(r => r.description as string),
      };
    }

    case "Encounter": {
      const [node] = await q(c,
        `MATCH (e:Encounter {encounter_id: '${safeId}'})
         RETURN e.description AS description, e.encounter_class AS encounter_class,
                e.start_date AS start_date, e.stop_date AS stop_date,
                e.reason_description AS reason_description, e.patient_id AS patient_id`);
      if (!node) return { type: nodeType, error: "Not found" };

      // Get patient name
      const [pat] = await q(c,
        `MATCH (p:Patient {patient_id: '${(node.patient_id as string).replace(/'/g, "''")}' })
         RETURN p.first_name AS fn, p.last_name AS ln`);

      // Get provider
      const provRows = await q(c,
        `MATCH (e:Encounter {encounter_id: '${safeId}'})-[:TREATED_BY]->(prov:Provider)
         RETURN prov.name AS name LIMIT 1`);

      // Get organization
      const orgRows = await q(c,
        `MATCH (e:Encounter {encounter_id: '${safeId}'})-[:AT_ORGANIZATION]->(org:Organization)
         RETURN org.name AS name LIMIT 1`);

      return {
        type: "Encounter",
        description: node.description,
        encounterClass: node.encounter_class,
        startDate: node.start_date,
        stopDate: node.stop_date,
        reason: node.reason_description,
        patient: pat ? `${pat.fn} ${pat.ln}` : null,
        provider: provRows[0]?.name ?? null,
        organization: orgRows[0]?.name ?? null,
      };
    }

    case "Provider": {
      const [node] = await q(c,
        `MATCH (prov:Provider {provider_id: '${safeId}'})
         RETURN prov.name AS name, prov.specialty AS specialty, prov.gender AS gender`);
      if (!node) return { type: nodeType, error: "Not found" };

      const orgRows = await q(c,
        `MATCH (prov:Provider {provider_id: '${safeId}'})-[:AFFILIATED_WITH]->(org:Organization)
         RETURN org.name AS name LIMIT 1`);
      const [patCount] = await q(c,
        `MATCH (e:Encounter)-[:TREATED_BY]->(prov:Provider {provider_id: '${safeId}'})
         RETURN count(DISTINCT e.patient_id) AS cnt`);

      return {
        type: "Provider",
        name: node.name,
        specialty: node.specialty,
        gender: node.gender,
        organization: orgRows[0]?.name ?? null,
        patientCount: (patCount?.cnt as number) ?? 0,
      };
    }

    case "Organization": {
      const [node] = await q(c,
        `MATCH (org:Organization {organization_id: '${safeId}'})
         RETURN org.name AS name, org.city AS city, org.state AS state, org.phone AS phone`);
      if (!node) return { type: nodeType, error: "Not found" };

      const [provCount] = await q(c,
        `MATCH (prov:Provider)-[:AFFILIATED_WITH]->(org:Organization {organization_id: '${safeId}'})
         RETURN count(prov) AS cnt`);

      return {
        type: "Organization",
        name: node.name,
        location: `${node.city}, ${node.state}`,
        phone: node.phone,
        providerCount: (provCount?.cnt as number) ?? 0,
      };
    }

    default:
      return { type: nodeType, id: nodeId };
  }
}
