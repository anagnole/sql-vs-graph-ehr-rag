import type { ParsedDataset } from "../parser/types.js";
import type { DataProfile, GroundTruthQuestion } from "./types.js";

let counter = 0;
function id() {
  return `COH-${++counter}`;
}
function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function generateCohort(
  ds: ParsedDataset,
  profile: DataProfile
): GroundTruthQuestion[] {
  counter = 0;
  const questions: GroundTruthQuestion[] = [];

  // Build per-patient condition sets and observation maps for reuse
  const patientConditionSets = new Map<string, Set<string>>();
  for (const c of ds.conditions) {
    let set = patientConditionSets.get(c.patientId);
    if (!set) {
      set = new Set();
      patientConditionSets.set(c.patientId, set);
    }
    set.add(c.description);
  }

  const patientMedSets = new Map<string, Set<string>>();
  for (const m of ds.medications) {
    let set = patientMedSets.get(m.patientId);
    if (!set) {
      set = new Set();
      patientMedSets.set(m.patientId, set);
    }
    set.add(m.description);
  }

  // 1. Condition co-occurrence counts
  const coOccurrencePairs = [
    ["Diabetes", "Hypertension"],
    ["Diabetes", "Hyperlipidemia"],
    ["Hypertension", "Hyperlipidemia"],
    ["Diabetes", "Chronic kidney disease"],
    ["Hypertension", "Chronic kidney disease"],
    ["Prediabetes", "Hypertension"],
    ["Diabetes", "Obesity"],
    ["Hypertension", "Obesity"],
    ["Asthma", "Obesity"],
    ["Diabetes", "Coronary heart disease"],
    ["Chronic kidney disease", "Anemia"],
    ["Osteoarthritis", "Obesity"],
  ];

  for (const [condA, condB] of coOccurrencePairs) {
    let count = 0;
    for (const [, condSet] of patientConditionSets) {
      const hasA = [...condSet].some((c) => c.toLowerCase().includes(condA.toLowerCase()));
      const hasB = [...condSet].some((c) => c.toLowerCase().includes(condB.toLowerCase()));
      if (hasA && hasB) count++;
    }
    if (count === 0) continue;

    questions.push({
      id: id(),
      type: "cohort",
      question: `How many patients have both ${condA} and ${condB}?`,
      answer: plural(count, "patient"),
      patientIds: [],
      domain: "conditions",
      supportingRecordIds: [],
    });
  }

  // 2. Average lab value for patients with a condition
  const labCondPairs = [
    { cond: "Diabetes", labCode: "4548-4", labName: "Hemoglobin A1c", domain: "diabetes" },
    { cond: "Chronic kidney disease", labCode: "2160-0", labName: "Creatinine", domain: "renal" },
    { cond: "Hyperlipidemia", labCode: "2093-3", labName: "Total Cholesterol", domain: "cardiovascular" },
    { cond: "Hypertension", labCode: "8480-6", labName: "Systolic Blood Pressure", domain: "cardiovascular" },
    { cond: "Chronic kidney disease", labCode: "33914-3", labName: "eGFR", domain: "renal" },
    { cond: "Diabetes", labCode: "39156-5", labName: "Body Mass Index", domain: "general" },
    { cond: "Diabetes", labCode: "2093-3", labName: "Total Cholesterol", domain: "cardiovascular" },
    { cond: "Hypertension", labCode: "2160-0", labName: "Creatinine", domain: "renal" },
    { cond: "Obesity", labCode: "39156-5", labName: "Body Mass Index", domain: "general" },
    { cond: "Prediabetes", labCode: "4548-4", labName: "Hemoglobin A1c", domain: "diabetes" },
  ];

  for (const { cond, labCode, labName, domain } of labCondPairs) {
    const values: number[] = [];
    for (const [patientId, condSet] of patientConditionSets) {
      const hasCond = [...condSet].some((c) => c.toLowerCase().includes(cond.toLowerCase()));
      if (!hasCond) continue;

      const obs = ds.byPatient.observations.get(patientId);
      if (!obs) continue;
      const matching = obs
        .filter((o) => o.code === labCode && o.type === "numeric")
        .sort((a, b) => b.date.localeCompare(a.date));
      if (matching.length > 0) {
        const val = parseFloat(matching[0].value);
        if (!isNaN(val)) values.push(val);
      }
    }
    if (values.length === 0) continue;

    const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
    questions.push({
      id: id(),
      type: "cohort",
      question: `What is the average most-recent ${labName} value for patients with ${cond}?`,
      answer: `${avg.toFixed(2)} (across ${values.length} patients)`,
      patientIds: [],
      domain,
      supportingRecordIds: [],
    });
  }

  // 3. Patients on a specific medication
  const topMeds = [...profile.medicationCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  for (const [medName] of topMeds) {
    let count = 0;
    for (const [, medSet] of patientMedSets) {
      if (medSet.has(medName)) count++;
    }
    questions.push({
      id: id(),
      type: "cohort",
      question: `How many patients have been prescribed ${medName}?`,
      answer: plural(count, "patient"),
      patientIds: [],
      domain: "medications",
      supportingRecordIds: [],
    });
  }

  // 4. Percentage threshold questions
  const pctQuestions: Array<{
    condFilter: string;
    labCode: string;
    labName: string;
    threshold: number;
    direction: "above" | "below";
    domain: string;
  }> = [
    { condFilter: "diabetes", labCode: "4548-4", labName: "A1C", threshold: 7.0, direction: "above", domain: "diabetes" },
    { condFilter: "hypertension", labCode: "8480-6", labName: "Systolic BP", threshold: 140, direction: "above", domain: "cardiovascular" },
    { condFilter: "chronic kidney disease", labCode: "33914-3", labName: "eGFR", threshold: 30, direction: "below", domain: "renal" },
    { condFilter: "hyperlipidemia", labCode: "2093-3", labName: "Total Cholesterol", threshold: 200, direction: "above", domain: "cardiovascular" },
  ];

  for (const pq of pctQuestions) {
    let condCount = 0;
    let matchCount = 0;
    for (const [patientId, condSet] of patientConditionSets) {
      const hasCond = [...condSet].some((c) => c.toLowerCase().includes(pq.condFilter));
      if (!hasCond) continue;
      condCount++;

      const obs = ds.byPatient.observations.get(patientId);
      if (!obs) continue;
      const lab = obs
        .filter((o) => o.code === pq.labCode && o.type === "numeric")
        .sort((a, b) => b.date.localeCompare(a.date));
      if (lab.length > 0) {
        const val = parseFloat(lab[0].value);
        if (pq.direction === "above" && val > pq.threshold) matchCount++;
        if (pq.direction === "below" && val < pq.threshold) matchCount++;
      }
    }
    if (condCount === 0) continue;

    const pct = ((matchCount / condCount) * 100).toFixed(1);
    const condLabel = pq.condFilter.charAt(0).toUpperCase() + pq.condFilter.slice(1);
    questions.push({
      id: id(),
      type: "cohort",
      question: `What percentage of patients with ${condLabel} have a most recent ${pq.labName} value ${pq.direction} ${pq.threshold}?`,
      answer: `${pct}% (${matchCount} of ${plural(condCount, "patient")})`,
      patientIds: [],
      domain: pq.domain,
      supportingRecordIds: [],
    });
  }

  // 5. Most common conditions by age group
  const ageGroups = [
    { label: "18-40", min: 18, max: 40 },
    { label: "41-60", min: 41, max: 60 },
    { label: "61-80", min: 61, max: 80 },
    { label: "80+", min: 80, max: 200 },
  ];

  const now = new Date();
  for (const group of ageGroups) {
    const condCounts = new Map<string, number>();
    let patientCount = 0;

    for (const patient of ds.patients) {
      const age = now.getFullYear() - new Date(patient.birthDate).getFullYear();
      if (age < group.min || age > group.max) continue;
      if (patient.deathDate) continue;
      patientCount++;

      const conds = patientConditionSets.get(patient.id);
      if (!conds) continue;
      for (const desc of conds) {
        condCounts.set(desc, (condCounts.get(desc) ?? 0) + 1);
      }
    }

    if (patientCount === 0) continue;
    const top5 = [...condCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name} (${count})`);

    questions.push({
      id: id(),
      type: "cohort",
      question: `What are the 5 most common conditions among living patients aged ${group.label}?`,
      answer: top5.join("; "),
      patientIds: [],
      domain: "conditions",
      supportingRecordIds: [],
    });
  }

  // 6. Gender-stratified condition prevalence
  for (const gender of ["M", "F"]) {
    const genderLabel = gender === "M" ? "male" : "female";
    const genderPatients = ds.patients.filter((p) => p.gender === gender && !p.deathDate);
    const condCounts = new Map<string, number>();
    for (const p of genderPatients) {
      const conds = patientConditionSets.get(p.id);
      if (!conds) continue;
      for (const desc of conds) {
        condCounts.set(desc, (condCounts.get(desc) ?? 0) + 1);
      }
    }
    const top5 = [...condCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name} (${count})`);

    questions.push({
      id: id(),
      type: "cohort",
      question: `What are the 5 most common conditions among ${genderLabel} patients?`,
      answer: top5.join("; "),
      patientIds: [],
      domain: "demographics",
      supportingRecordIds: [],
    });
  }

  // 7. Single-condition prevalence counts
  const prevalenceConditions = [
    "Diabetes",
    "Hypertension",
    "Asthma",
    "Chronic kidney disease",
    "Obesity",
    "Depression",
    "Osteoarthritis",
    "Anemia",
  ];

  for (const cond of prevalenceConditions) {
    let count = 0;
    for (const [, condSet] of patientConditionSets) {
      if ([...condSet].some((c) => c.toLowerCase().includes(cond.toLowerCase()))) count++;
    }
    if (count === 0) continue;

    questions.push({
      id: id(),
      type: "cohort",
      question: `How many patients have been diagnosed with ${cond}?`,
      answer: plural(count, "patient"),
      patientIds: [],
      domain: "conditions",
      supportingRecordIds: [],
    });
  }

  // 8. Triple condition co-occurrence
  const triplePairs = [
    ["Diabetes", "Hypertension", "Hyperlipidemia"],
    ["Diabetes", "Hypertension", "Chronic kidney disease"],
    ["Diabetes", "Obesity", "Hypertension"],
    ["Hypertension", "Hyperlipidemia", "Obesity"],
  ];

  for (const [condA, condB, condC] of triplePairs) {
    let count = 0;
    for (const [, condSet] of patientConditionSets) {
      const hasA = [...condSet].some((c) => c.toLowerCase().includes(condA.toLowerCase()));
      const hasB = [...condSet].some((c) => c.toLowerCase().includes(condB.toLowerCase()));
      const hasC = [...condSet].some((c) => c.toLowerCase().includes(condC.toLowerCase()));
      if (hasA && hasB && hasC) count++;
    }
    if (count === 0) continue;

    questions.push({
      id: id(),
      type: "cohort",
      question: `How many patients have ${condA}, ${condB}, and ${condC}?`,
      answer: plural(count, "patient"),
      patientIds: [],
      domain: "conditions",
      supportingRecordIds: [],
    });
  }

  // 9. Medication class prevalence
  const medClasses = [
    { keyword: "statin", label: "a statin", domain: "medications" },
    { keyword: "metformin", label: "Metformin", domain: "medications" },
    { keyword: "insulin", label: "insulin", domain: "medications" },
    { keyword: "lisinopril", label: "Lisinopril", domain: "medications" },
    { keyword: "amlodipine", label: "Amlodipine", domain: "medications" },
    { keyword: "hydrochlorothiazide", label: "Hydrochlorothiazide", domain: "medications" },
  ];

  for (const mc of medClasses) {
    let count = 0;
    for (const [, medSet] of patientMedSets) {
      if ([...medSet].some((m) => m.toLowerCase().includes(mc.keyword))) count++;
    }
    if (count === 0) continue;

    questions.push({
      id: id(),
      type: "cohort",
      question: `How many patients have ever been prescribed ${mc.label}?`,
      answer: plural(count, "patient"),
      patientIds: [],
      domain: mc.domain,
      supportingRecordIds: [],
    });
  }

  // 10. Average encounter count per condition
  const encConditions = ["Diabetes", "Hypertension", "Asthma", "Chronic kidney disease"];
  for (const cond of encConditions) {
    const encCounts: number[] = [];
    for (const patient of ds.patients) {
      const condSet = patientConditionSets.get(patient.id);
      if (!condSet) continue;
      if (![...condSet].some((c) => c.toLowerCase().includes(cond.toLowerCase()))) continue;
      const encs = ds.byPatient.encounters.get(patient.id);
      if (encs) encCounts.push(encs.length);
    }
    if (encCounts.length === 0) continue;

    const avg = encCounts.reduce((s, v) => s + v, 0) / encCounts.length;
    questions.push({
      id: id(),
      type: "cohort",
      question: `What is the average number of encounters for patients with ${cond}?`,
      answer: `${avg.toFixed(1)} encounters (across ${encCounts.length} patients)`,
      patientIds: [],
      domain: "general",
      supportingRecordIds: [],
    });
  }

  // 11. Most prescribed medications overall
  {
    const medPatientCounts = new Map<string, number>();
    for (const [, medSet] of patientMedSets) {
      for (const med of medSet) {
        medPatientCounts.set(med, (medPatientCounts.get(med) ?? 0) + 1);
      }
    }
    const top10 = [...medPatientCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => `${name} (${count})`);

    questions.push({
      id: id(),
      type: "cohort",
      question: "What are the 10 most commonly prescribed medications across all patients?",
      answer: top10.join("; "),
      patientIds: [],
      domain: "medications",
      supportingRecordIds: [],
    });
  }

  return questions;
}
