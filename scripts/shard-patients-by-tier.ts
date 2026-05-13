/**
 * Shard the monolithic patients.json (all 20k patients, 7.3GB) into
 * per-tier files so llm-only at tier-200 doesn't stream 7GB to find
 * 200 patients. Output files live next to the source:
 *
 *   data/generated/patients-tier-200.json    (~70MB,  200 patients)
 *   data/generated/patients-tier-2000.json   (~700MB, 2k patients)
 *
 * Tier-20000 is the whole file; no shard is written.
 *
 * Streams the input + writes the output incrementally so memory stays
 * flat. The output mirrors the input shape: a JSON object keyed by
 * patient ID.
 *
 * Usage:
 *   npx tsx scripts/shard-patients-by-tier.ts                # 200 + 2000
 *   npx tsx scripts/shard-patients-by-tier.ts --tier 200
 */

import { createReadStream, createWriteStream, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parser } = require('stream-json');
const { streamObject } = require('stream-json/streamers/StreamObject');

const PROJECT_ROOT = join(import.meta.dirname, '..');
const GEN_DIR = join(PROJECT_ROOT, 'data', 'generated');

async function shardTier(tier: string): Promise<void> {
  const inFile = join(GEN_DIR, 'patients.json');
  const idFile = join(GEN_DIR, `tier-${tier}.json`);
  const outFile = join(GEN_DIR, `patients-tier-${tier}.json`);

  if (!existsSync(inFile)) throw new Error(`Missing ${inFile}`);
  if (!existsSync(idFile)) throw new Error(`Missing ${idFile}`);

  const ids: string[] = JSON.parse(readFileSync(idFile, 'utf-8'));
  const idSet = new Set(ids);
  console.log(`Tier ${tier}: ${idSet.size} target patient IDs`);

  const writeStream = createWriteStream(outFile);
  writeStream.write('{');
  let written = 0;
  let scanned = 0;
  const startedAt = Date.now();

  await pipeline(
    createReadStream(inFile),
    parser(),
    streamObject(),
    new Transform({
      objectMode: true,
      transform(chunk: { key: string; value: unknown }, _enc, cb) {
        scanned++;
        if (scanned % 1000 === 0) {
          process.stdout.write(`  scanned ${scanned}, matched ${written}\r`);
        }
        if (idSet.has(chunk.key)) {
          const prefix = written === 0 ? '' : ',';
          const line = `${prefix}${JSON.stringify(chunk.key)}:${JSON.stringify(chunk.value)}`;
          const ok = writeStream.write(line);
          written++;
          if (!ok) {
            // Backpressure — wait for drain before letting the next chunk land.
            writeStream.once('drain', cb);
            return;
          }
        }
        cb();
      },
    }),
  );

  writeStream.write('}');
  await new Promise<void>((resolve, reject) => {
    writeStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });

  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n  wrote ${written}/${idSet.size} patients to ${outFile} in ${elapsedS}s`);
  if (written !== idSet.size) {
    console.warn(`  WARN: ${idSet.size - written} patient IDs from tier-${tier}.json not found in patients.json`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--tier');
  const tierArg = idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;

  const tiers = tierArg ? [tierArg] : ['200', '2000'];
  for (const t of tiers) {
    if (!['200', '2000', '20000'].includes(t)) {
      throw new Error(`Invalid tier '${t}' (must be 200, 2000, or 20000)`);
    }
    if (t === '20000') {
      console.log('Tier 20000 = patients.json itself; skipping shard.');
      continue;
    }
    await shardTier(t);
  }
}

main().catch((err) => {
  console.error('Shard failed:', err);
  process.exit(1);
});
