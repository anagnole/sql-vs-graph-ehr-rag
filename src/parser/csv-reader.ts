import { createReadStream } from "node:fs";
import { parse } from "csv-parse";

/**
 * Read a CSV file row-by-row using a streaming parser. This is the only way
 * to handle multi-GB Synthea exports (e.g. observations.csv at 3GB+ from a
 * 20k-patient cohort) — readFileSync caps at 2GB and JS strings cap at 512MB.
 */
export async function readCsv<T>(filePath: string): Promise<T[]> {
  const rows: T[] = [];
  const parser = createReadStream(filePath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }),
  );
  for await (const row of parser) {
    rows.push(row as T);
  }
  return rows;
}
