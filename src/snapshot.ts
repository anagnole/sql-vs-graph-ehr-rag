import { writeFileSync, createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ParsedDataset } from "./parser/types.js";
import type { GroundTruthQuestion } from "./questions/types.js";

function bundlePatient(patientId: string, ds: ParsedDataset) {
  return {
    patient: ds.patientById.get(patientId)!,
    encounters: ds.byPatient.encounters.get(patientId) ?? [],
    conditions: ds.byPatient.conditions.get(patientId) ?? [],
    medications: ds.byPatient.medications.get(patientId) ?? [],
    observations: ds.byPatient.observations.get(patientId) ?? [],
    procedures: ds.byPatient.procedures.get(patientId) ?? [],
  };
}

export async function writePatientBundles(filePath: string, ds: ParsedDataset): Promise<void> {
  const stream = createWriteStream(filePath);

  // Handle backpressure — without this, the sync loop fills the write buffer
  // faster than the disk drains and Node GC-thrashes for many minutes on a
  // 23k-patient dataset (~7GB output).
  const writeWithDrain = (chunk: string): Promise<void> => {
    if (stream.write(chunk)) return Promise.resolve();
    return new Promise((resolve) => stream.once("drain", () => resolve()));
  };

  await writeWithDrain("{\n");
  const patients = ds.patients;
  const logEvery = Math.max(1, Math.floor(patients.length / 20));
  for (let i = 0; i < patients.length; i++) {
    const bundle = bundlePatient(patients[i].id, ds);
    const key = JSON.stringify(patients[i].id);
    await writeWithDrain(`  ${key}: ${JSON.stringify(bundle)}`);
    if (i < patients.length - 1) await writeWithDrain(",");
    await writeWithDrain("\n");
    if ((i + 1) % logEvery === 0 || i === patients.length - 1) {
      console.log(`  patients written: ${i + 1}/${patients.length}`);
    }
  }
  await writeWithDrain("}\n");
  await new Promise<void>((resolve, reject) => {
    stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
}

export async function writeSnapshot(
  outDir: string,
  ds: ParsedDataset,
  allQuestions: GroundTruthQuestion[],
  curatedQuestions: GroundTruthQuestion[]
): Promise<void> {
  mkdirSync(outDir, { recursive: true });

  // Patient bundles — stream to avoid string length limit
  console.log("Writing patients.json...");
  await writePatientBundles(join(outDir, "patients.json"), ds);

  // Providers
  console.log("Writing providers.json...");
  const providers: Record<string, { provider: typeof ds.providers[0]; organization: typeof ds.organizations[0] | null }> = {};
  for (const provider of ds.providers) {
    providers[provider.id] = {
      provider,
      organization: ds.organizationById.get(provider.organizationId) ?? null,
    };
  }
  writeFileSync(join(outDir, "providers.json"), JSON.stringify(providers, null, 2));

  // All candidate questions (ground truth)
  console.log("Writing ground-truth.json...");
  writeFileSync(join(outDir, "ground-truth.json"), JSON.stringify(allQuestions, null, 2));

  // Curated evaluation questions
  console.log("Writing evaluation-questions.json...");
  writeFileSync(join(outDir, "evaluation-questions.json"), JSON.stringify(curatedQuestions, null, 2));

  // Summary stats
  const stats = {
    patients: ds.patients.length,
    encounters: ds.encounters.length,
    conditions: ds.conditions.length,
    medications: ds.medications.length,
    observations: ds.observations.length,
    procedures: ds.procedures.length,
    providers: ds.providers.length,
    organizations: ds.organizations.length,
    totalCandidateQuestions: allQuestions.length,
    curatedQuestions: curatedQuestions.length,
    questionsByType: Object.fromEntries(
      ["simple-lookup", "multi-hop", "temporal", "cohort", "reasoning", "unanswerable"].map((t) => [
        t,
        curatedQuestions.filter((q) => q.type === t).length,
      ])
    ),
  };
  console.log("Writing stats.json...");
  writeFileSync(join(outDir, "stats.json"), JSON.stringify(stats, null, 2));
}
