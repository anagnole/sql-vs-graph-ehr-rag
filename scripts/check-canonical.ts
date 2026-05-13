import kuzu from 'kuzu';

const tier = process.argv[2] ?? '200';
const db = new kuzu.Database(`.brainifai/data/kuzu-${tier}`, 0, true, true);
const c = new kuzu.Connection(db);

const total = await (await c.query(`MATCH ()-[r:HAS_RESULT]->() RETURN count(*) AS n`)).getAll();
const nonNull = await (await c.query(`MATCH ()-[r:HAS_RESULT]->() WHERE r.value_canonical IS NOT NULL RETURN count(*) AS n`)).getAll();
const tn = Number((total[0] as any).n);
const nn = Number((nonNull[0] as any).n);
console.log(`tier-${tier}: ${nn}/${tn} rows have non-null value_canonical (${((nn/tn)*100).toFixed(1)}%)`);
