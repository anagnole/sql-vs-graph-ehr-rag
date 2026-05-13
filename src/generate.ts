import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSyntheaData } from "./parser/index.js";
import { parseSnapshotData } from "./parser/snapshot-reader.js";
import { profileDataset, generateAllQuestions } from "./questions/index.js";
import { curateQuestions } from "./curate.js";
import { writeSnapshot } from "./snapshot.js";

const DATA_DIR = join(import.meta.dirname, "..", "data", "synthea");
const OUT_DIR = join(import.meta.dirname, "..", "data", "generated");

// --tier N — reads only patients in data/generated/tier-N.json. Useful on
// machines without the heap budget to parse the full 20k snapshot (~10 GB).
const tierArg = (() => {
  const i = process.argv.indexOf("--tier");
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
})();

console.log("=== ThesisBrainifai Data Generation ===\n");

// Step 1: Load the dataset. Prefer Synthea CSVs when present; fall back to the
// JSON snapshot (data/generated/patients.json) when they aren't — lets us
// re-run question generation after CSVs have been cleaned up for disk space.
const useCsv = existsSync(join(DATA_DIR, "encounters.csv"));
if (!useCsv) {
  console.log("Synthea CSVs not found — reading from JSON snapshot instead.\n");
}

let patientIdFilter: Set<string> | undefined;
if (tierArg) {
  const tierFile = join(OUT_DIR, `tier-${tierArg}.json`);
  if (!existsSync(tierFile)) throw new Error(`Tier file not found: ${tierFile}`);
  const ids: string[] = JSON.parse(readFileSync(tierFile, "utf-8"));
  patientIdFilter = new Set(ids);
  console.log(`Tier mode: --tier ${tierArg} — reading ${ids.length} patients only.\n`);
}

const dataset = useCsv
  ? await parseSyntheaData(DATA_DIR)
  : await parseSnapshotData(OUT_DIR, { patientIdFilter });

// Step 2: Profile the dataset
console.log("\nProfiling dataset...");
const profile = profileDataset(dataset);
console.log(`  Unique conditions: ${profile.conditionCounts.size}`);
console.log(`  Unique observation codes: ${profile.observationCoverage.size}`);
console.log(`  Unique medications: ${profile.medicationCounts.size}`);
console.log(`  Encounter classes: ${[...profile.encounterClassCounts.keys()].join(", ")}`);

// Step 3: Generate candidate questions
const allQuestions = generateAllQuestions(dataset, profile);

// Step 4: Curate evaluation set
console.log("\nCurating evaluation questions...");
const curated = curateQuestions(allQuestions);
console.log(`Selected ${curated.length} questions:`);
for (const type of ["simple-lookup", "multi-hop", "temporal", "cohort", "reasoning", "unanswerable"] as const) {
  const count = curated.filter((q) => q.type === type).length;
  const domains = new Set(curated.filter((q) => q.type === type).map((q) => q.domain));
  console.log(`  ${type}: ${count} questions, ${domains.size} domains`);
}

// Step 5: Write outputs
console.log("\nWriting outputs...");
await writeSnapshot(OUT_DIR, dataset, allQuestions, curated);

console.log("\n=== Done ===");
