import type { ParsedDataset } from "../parser/types.js";
import type { DataProfile, GroundTruthQuestion } from "./types.js";

let counter = 0;
function id() {
  return `NEG-${++counter}`;
}

/**
 * Generate negation questions — "Does patient X have Y?" where X does NOT have Y.
 * Tests absence reasoning: the system must affirm "no" without hallucinating
 * a fabricated affirmative. Distinct from unanswerable: the data IS present,
 * the answer is definitively "no".
 *
 * Categories:
 * 1. Condition negation (patient lacks a specific condition)
 * 2. Medication negation (patient not on a specific drug)
 * 3. Procedure negation (patient has not undergone a specific procedure)
 * 4. Allergy negation — treated as unanswerable elsewhere (Synthea lacks allergies)
 */
export function generateNegation(
  ds: ParsedDataset,
  _profile: DataProfile
): GroundTruthQuestion[] {
  counter = 0;
  const questions: GroundTruthQuestion[] = [];
  const sortedPatients = [...ds.patients].sort((a, b) => a.id.localeCompare(b.id));

  // 1. Condition negation — pick common conditions and confirm the patient lacks them
  const probeConditions = [
    "Diabetes",
    "Hypertension",
    "Asthma",
    "Osteoarthritis",
    "Anemia",
    "Atrial fibrillation",
    "Chronic obstructive",
    "Hyperlipidemia",
  ];

  let condCount = 0;
  for (const patient of sortedPatients.slice(0, 200)) {
    if (condCount >= 10) break;
    const conds = ds.byPatient.conditions.get(patient.id);
    const descs = (conds ?? []).map((c) => c.description.toLowerCase());

    for (const probe of probeConditions) {
      if (condCount >= 10) break;
      const hasIt = descs.some((d) => d.includes(probe.toLowerCase()));
      if (hasIt) continue;

      questions.push({
        id: id(),
        type: "negation",
        question: `Does patient ${patient.firstName} ${patient.lastName} (ID: ${patient.id}) have ${probe}?`,
        answer: `No. ${probe} is not recorded in the patient's conditions.`,
        patientIds: [patient.id],
        domain: "condition-negation",
        supportingRecordIds: [],
      });
      condCount++;
      break;
    }
  }

  // 2. Medication negation
  const probeMeds = [
    "Warfarin",
    "Metformin",
    "Insulin",
    "Atorvastatin",
    "Lisinopril",
    "Aspirin",
    "Levothyroxine",
    "Amlodipine",
  ];

  let medCount = 0;
  for (const patient of sortedPatients.slice(0, 200)) {
    if (medCount >= 6) break;
    const meds = ds.byPatient.medications.get(patient.id);
    const activeDescs = (meds ?? [])
      .filter((m) => !m.stopDate)
      .map((m) => m.description.toLowerCase());

    for (const probe of probeMeds) {
      if (medCount >= 6) break;
      const hasIt = activeDescs.some((d) => d.includes(probe.toLowerCase()));
      if (hasIt) continue;

      questions.push({
        id: id(),
        type: "negation",
        question: `Is patient ${patient.firstName} ${patient.lastName} (ID: ${patient.id}) currently taking ${probe}?`,
        answer: `No. ${probe} is not in the patient's active medications.`,
        patientIds: [patient.id],
        domain: "medication-negation",
        supportingRecordIds: [],
      });
      medCount++;
      break;
    }
  }

  // 3. Procedure negation
  const probeProcs = [
    "Colonoscopy",
    "Coronary artery bypass",
    "Appendectomy",
    "Hip replacement",
    "Cataract surgery",
  ];

  let procCount = 0;
  for (const patient of sortedPatients.slice(0, 200)) {
    if (procCount >= 4) break;
    const procs = ds.byPatient.procedures.get(patient.id);
    const descs = (procs ?? []).map((p) => p.description.toLowerCase());

    for (const probe of probeProcs) {
      if (procCount >= 4) break;
      const hasIt = descs.some((d) => d.includes(probe.toLowerCase()));
      if (hasIt) continue;

      questions.push({
        id: id(),
        type: "negation",
        question: `Has patient ${patient.firstName} ${patient.lastName} (ID: ${patient.id}) undergone a ${probe}?`,
        answer: `No. No ${probe} procedure is recorded for this patient.`,
        patientIds: [patient.id],
        domain: "procedure-negation",
        supportingRecordIds: [],
      });
      procCount++;
      break;
    }
  }

  return questions;
}
