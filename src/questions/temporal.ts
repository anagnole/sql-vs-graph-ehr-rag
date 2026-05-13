import type { ParsedDataset } from "../parser/types.js";
import { type DataProfile, type GroundTruthQuestion, isPlausibleValue, normalizeUnits } from "./types.js";

let counter = 0;
function id() {
  return `TMP-${++counter}`;
}

/**
 * Classify trend using linear regression slope rather than just first-vs-last.
 * Returns "increasing", "decreasing", or "stable" based on normalized slope.
 */
function classifyTrend(values: number[]): "increasing" | "decreasing" | "stable" {
  const n = values.length;
  if (n < 2) return "stable";
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const relSlope = yMean === 0 ? 0 : slope / Math.abs(yMean);
  if (relSlope > 0.03) return "increasing";
  if (relSlope < -0.03) return "decreasing";
  return "stable";
}

export function generateTemporal(
  ds: ParsedDataset,
  profile: DataProfile
): GroundTruthQuestion[] {
  counter = 0;
  const questions: GroundTruthQuestion[] = [];
  const sortedPatients = [...ds.patients].sort((a, b) => a.id.localeCompare(b.id));

  // 1. Lab value trend over time — per patient per lab code
  const trendLabs = [
    { code: "4548-4", name: "Hemoglobin A1c", domain: "diabetes" },
    { code: "2160-0", name: "Creatinine", domain: "renal" },
    { code: "8480-6", name: "Systolic Blood Pressure", domain: "cardiovascular" },
    { code: "2093-3", name: "Total Cholesterol", domain: "cardiovascular" },
    { code: "33914-3", name: "eGFR", domain: "renal" },
    { code: "2571-8", name: "Triglycerides", domain: "cardiovascular" },
    { code: "2085-9", name: "HDL Cholesterol", domain: "cardiovascular" },
    { code: "39156-5", name: "Body Mass Index", domain: "general" },
  ];

  for (const lab of trendLabs) {
    let perLabCount = 0;
    for (const patient of sortedPatients) {
      if (perLabCount >= 8) break;
      const obs = ds.byPatient.observations.get(patient.id);
      if (!obs) continue;
      const matching = obs
        .filter((o) => o.code === lab.code && o.type === "numeric")
        .sort((a, b) => a.date.localeCompare(b.date));
      if (matching.length < 3) continue;

      const recent = matching.slice(-5);
      // Skip if any value is clinically implausible
      if (recent.some((o) => !isPlausibleValue(lab.code, o.value))) continue;
      const values = recent.map((o) => parseFloat(o.value));
      // Skip series with outliers (>3x or <0.3x the median)
      const sortedVals = [...values].sort((a, b) => a - b);
      const median = sortedVals[Math.floor(sortedVals.length / 2)];
      if (median > 0 && values.some((v) => v > median * 3 || v < median * 0.3)) continue;

      const trendData = recent.map((o) => `${o.date.slice(0, 10)}: ${o.value} ${normalizeUnits(lab.code, o.units)}`);
      const trend = classifyTrend(values);

      questions.push({
        id: id(),
        type: "temporal",
        question: `What is the trend in ${lab.name} values for patient ${patient.firstName} ${patient.lastName} (ID: ${patient.id}) over their recent measurements?`,
        answer: `${trend} trend. Values: ${trendData.join(", ")}`,
        patientIds: [patient.id],
        domain: lab.domain,
        supportingRecordIds: recent.map((o) => o.id),
      });
      perLabCount++;
    }
  }

  // 2. First diagnosis date for a condition
  const condTargets = [
    "Diabetes", "Hypertension", "Prediabetes", "Hyperlipidemia",
    "Osteoarthritis", "Chronic kidney disease", "Asthma", "Atrial Fibrillation",
    "Anemia", "Depression",
  ];

  for (const condName of condTargets) {
    let perCondCount = 0;
    for (const patient of sortedPatients) {
      if (perCondCount >= 8) break;
      const conds = ds.byPatient.conditions.get(patient.id);
      if (!conds) continue;
      const matching = conds
        .filter((c) => c.description.toLowerCase().includes(condName.toLowerCase()))
        .sort((a, b) => a.startDate.localeCompare(b.startDate));
      if (matching.length === 0) continue;

      questions.push({
        id: id(),
        type: "temporal",
        question: `When was patient ${patient.firstName} ${patient.lastName} (ID: ${patient.id}) first diagnosed with ${matching[0].description}?`,
        answer: matching[0].startDate.slice(0, 10),
        patientIds: [patient.id],
        domain: "conditions",
        supportingRecordIds: [matching[0].id],
      });
      perCondCount++;
    }
  }

  // 3. Medication duration (>= 7 days only)
  let q3Count = 0;
  for (const patient of sortedPatients) {
    if (q3Count >= 40) break;
    const meds = ds.byPatient.medications.get(patient.id);
    if (!meds) continue;
    const stopped = meds.filter((m) => m.stopDate).sort((a, b) => a.description.localeCompare(b.description));

    const med = stopped.find((m) => {
      const days = Math.round((new Date(m.stopDate!).getTime() - new Date(m.startDate).getTime()) / (1000 * 60 * 60 * 24));
      return days >= 7;
    });
    if (!med) continue;

    const start = new Date(med.startDate);
    const stop = new Date(med.stopDate!);
    const days = Math.round((stop.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));

    questions.push({
      id: id(),
      type: "temporal",
      question: `How long was patient ${patient.firstName} ${patient.lastName} (ID: ${patient.id}) on ${med.description}?`,
      answer: `${days} days (from ${med.startDate.slice(0, 10)} to ${med.stopDate!.slice(0, 10)})`,
      patientIds: [patient.id],
      domain: "medications",
      supportingRecordIds: [med.id],
    });
    q3Count++;
  }

  // 4. Medications started within 6 months of a diagnosis
  let q4Count = 0;
  for (const patient of sortedPatients) {
    if (q4Count >= 40) break;
    const conds = ds.byPatient.conditions.get(patient.id);
    const meds = ds.byPatient.medications.get(patient.id);
    if (!conds || !meds) continue;

    for (const cond of conds) {
      if (q4Count >= 40) break;
      const diagDate = new Date(cond.startDate);
      const sixMonthsLater = new Date(diagDate);
      sixMonthsLater.setMonth(sixMonthsLater.getMonth() + 6);

      const medsInWindow = meds.filter((m) => {
        const mDate = new Date(m.startDate);
        return mDate >= diagDate && mDate <= sixMonthsLater;
      });

      if (medsInWindow.length < 2) continue;

      const medNames = [...new Set(medsInWindow.map((m) => m.description))].sort();
      questions.push({
        id: id(),
        type: "temporal",
        question: `What medications were started within 6 months of ${patient.firstName} ${patient.lastName} (ID: ${patient.id}) being diagnosed with ${cond.description}?`,
        answer: medNames.join("; "),
        patientIds: [patient.id],
        domain: "medications",
        supportingRecordIds: [cond.id, ...medsInWindow.map((m) => m.id)],
      });
      q4Count++;
      break;
    }
  }

  // 5. Chronological condition ordering
  let q5Count = 0;
  for (const patient of sortedPatients) {
    if (q5Count >= 40) break;
    const conds = ds.byPatient.conditions.get(patient.id);
    if (!conds) continue;
    const uniqueConds = new Map<string, typeof conds[0]>();
    for (const c of conds) {
      if (!uniqueConds.has(c.description)) uniqueConds.set(c.description, c);
    }
    if (uniqueConds.size < 3) continue;

    const sorted = [...uniqueConds.values()].sort((a, b) => a.startDate.localeCompare(b.startDate));
    const first5 = sorted.slice(0, 5);
    const timeline = first5.map((c) => `${c.startDate.slice(0, 10)}: ${c.description}`);

    questions.push({
      id: id(),
      type: "temporal",
      question: `In what chronological order were conditions diagnosed for patient ${patient.firstName} ${patient.lastName} (ID: ${patient.id})?`,
      answer: timeline.join("; "),
      patientIds: [patient.id],
      domain: "conditions",
      supportingRecordIds: first5.map((c) => c.id),
    });
    q5Count++;
  }

  return questions;
}
