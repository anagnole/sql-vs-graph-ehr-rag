import kuzu from 'kuzu';
import { join } from 'node:path';

const dbPath = process.argv[2] ?? join(process.cwd(), '.brainifai/data/kuzu-200');
const db = new kuzu.Database(dbPath, 0, true, true);
const conn = new kuzu.Connection(db);

async function q(query: string) {
  const res = await conn.query(query);
  return await res.getAll();
}

console.log(`DB: ${dbPath}`);
console.log('\nHAS_RESULT sample row (shows columns):');
try {
  const rows = await q(`MATCH ()-[r:HAS_RESULT]->() RETURN r LIMIT 1`);
  if (rows.length === 0) {
    console.log('  (no rows)');
  } else {
    console.log(JSON.stringify(rows[0], null, 2));
  }
} catch (e) {
  console.log(' MATCH failed:', (e as Error).message);
}

console.log('\nDoes value_canonical column exist?');
try {
  const rows = await q(`MATCH ()-[r:HAS_RESULT]->() RETURN r.value_canonical AS vc LIMIT 1`);
  console.log('  YES, sample value:', rows[0]?.vc);
} catch (e) {
  console.log('  NO —', (e as Error).message);
}
