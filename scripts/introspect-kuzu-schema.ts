/**
 * Print the Kuzu schema (node tables, rel tables, properties) for use in
 * the graph-cypher system prompt. Run with KUZU_DB_PATH set to any tier.
 */
import { join } from "node:path";
import { getConnection, withLock } from "../src/api/kuzu-client.js";

process.env.KUZU_DB_PATH = process.env.KUZU_DB_PATH ?? join(import.meta.dirname, "..", ".brainifai/data/kuzu-200");

async function main() {
  await withLock(async () => {
    const c = await getConnection();
    const tables = (await (await c.query("CALL show_tables() RETURN *")).getAll()) as any[];
    console.log("=== Tables ===");
    for (const t of tables) console.log(JSON.stringify(t));
    console.log();
    for (const t of tables) {
      const name = t.name ?? t["name"];
      if (!name) continue;
      console.log(`--- ${name} (${t.type}) ---`);
      try {
        const props = (await (await c.query(`CALL TABLE_INFO('${name}') RETURN *`)).getAll()) as any[];
        for (const p of props) console.log("  " + JSON.stringify(p));
      } catch (e) {
        console.log("  (TABLE_INFO failed: " + (e as Error).message + ")");
      }
    }
  });
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
