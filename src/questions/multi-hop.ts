import type { ParsedDataset } from "../parser/types.js";
import type { DataProfile, GroundTruthQuestion } from "./types.js";

let counter = 0;
function id() {
  return `MH-${++counter}`;
}

export function generateMultiHop(
  ds: ParsedDataset,
  profile: DataProfile
): GroundTruthQuestion[] {
  counter = 0;
  const questions: GroundTruthQuestion[] = [];
  const sortedPatients = [...ds.patients].sort((a, b) => a.id.localeCompare(b.id));

  // 1. Medications prescribed at the encounter where condition X was diagnosed
  const targetConditions = [
    "Diabetes", "Hypertension", "Prediabetes", "Anemia",
    "Hyperlipidemia", "Osteoarthritis", "Chronic kidney disease",
    "Atrial Fibrillation", "Asthma", "Depression",
  ];

  let q1Count = 0;
  for (const patient of sortedPatients) {
    if (q1Count >= 40) break;
    const conds = ds.byPatient.conditions.get(patient.id);
    if (!conds) continue;

    for (const targetCond of targetConditions) {
      if (q1Count >= 40) break;
      const cond = conds.find((c) =>
        c.description.toLowerCase().includes(targetCond.toLowerCase())
      );
      if (!cond) continue;

      const encMeds = ds.byEncounter.medications.get(cond.encounterId);
      if (!encMeds || encMeds.length === 0) continue;

      const medNames = [...new Set(encMeds.map((m) => m.description))].sort();
      questions.push({
        id: id(),
        type: "multi-hop",
        question: `What medications were prescribed at the encounter where ${patient.firstName} ${patient.lastName} (ID: ${patient.id}) was diagnosed with ${cond.description}?`,
        answer: medNames.join("; "),
        patientIds: [patient.id],
        domain: "medications",
        supportingRecordIds: [cond.id, ...encMeds.map((m) => m.id)],
      });
      q1Count++;
      break; // one per patient for this category
    }
  }

  // 2. Procedures at most recent emergency visit
  let q2Count = 0;
  for (const patient of sortedPatients) {
    if (q2Count >= 40) break;
    const encs = ds.byPatient.encounters.get(patient.id);
    if (!encs) continue;
    const emergency = encs
      .filter((e) => e.encounterClass === "emergency" || e.encounterClass === "urgentcare")
      .sort((a, b) => b.startDate.localeCompare(a.startDate));
    if (emergency.length === 0) continue;

    const procs = ds.byEncounter.procedures.get(emergency[0].id);
    if (!procs || procs.length === 0) continue;

    const procNames = [...new Set(procs.map((p) => p.description))].sort();
    questions.push({
      id: id(),
      type: "multi-hop",
      question: `What procedures were performed at the most recent emergency visit for ${patient.firstName} ${patient.lastName} (ID: ${patient.id})?`,
      answer: procNames.join("; "),
      patientIds: [patient.id],
      domain: "procedures",
      supportingRecordIds: [emergency[0].id, ...procs.map((p) => p.id)],
    });
    q2Count++;
  }

  // 3. Lab value at encounter where medication was first prescribed
  const targetMeds = [
    "Metformin", "Lisinopril", "Atorvastatin", "Amlodipine",
    "Hydrochlorothiazide", "Simvastatin", "Losartan",
    "Omeprazole", "Insulin", "Warfarin",
  ];

  let q3Count = 0;
  for (const patient of sortedPatients) {
    if (q3Count >= 40) break;
    const meds = ds.byPatient.medications.get(patient.id);
    if (!meds) continue;

    for (const targetMed of targetMeds) {
      if (q3Count >= 40) break;
      const matchingMeds = meds
        .filter((m) => m.description.toLowerCase().includes(targetMed.toLowerCase()))
        .sort((a, b) => a.startDate.localeCompare(b.startDate));
      if (matchingMeds.length === 0) continue;

      const firstMed = matchingMeds[0];
      const encObs = ds.byEncounter.observations.get(firstMed.encounterId);
      if (!encObs) continue;
      const numericObs = encObs.filter((o) => o.type === "numeric");
      if (numericObs.length === 0) continue;

      const obs = numericObs[0];
      questions.push({
        id: id(),
        type: "multi-hop",
        question: `What was the ${obs.description} value at the encounter where ${patient.firstName} ${patient.lastName} (ID: ${patient.id}) was first prescribed ${firstMed.description}?`,
        answer: `${obs.value} ${obs.units}`,
        patientIds: [patient.id],
        domain: "labs",
        supportingRecordIds: [firstMed.id, obs.id],
      });
      q3Count++;
      break;
    }
  }

  // 4. Provider who diagnosed a specific condition
  let q4Count = 0;
  for (const patient of sortedPatients) {
    if (q4Count >= 40) break;
    const conds = ds.byPatient.conditions.get(patient.id);
    if (!conds) continue;

    for (const cond of conds) {
      if (q4Count >= 40) break;
      const encounter = ds.encounterById.get(cond.encounterId);
      if (!encounter) continue;
      const provider = ds.providerById.get(encounter.providerId);
      if (!provider) continue;

      questions.push({
        id: id(),
        type: "multi-hop",
        question: `Which provider diagnosed ${patient.firstName} ${patient.lastName} (ID: ${patient.id}) with ${cond.description}?`,
        answer: `${provider.name} (${provider.specialty})`,
        patientIds: [patient.id],
        domain: "providers",
        supportingRecordIds: [cond.id, encounter.id],
      });
      q4Count++;
      break;
    }
  }

  return questions;
}
