import type { ParsedDataset } from "../parser/types.js";
import { type DataProfile, type GroundTruthQuestion, isPlausibleValue } from "./types.js";

let counter = 0;
function id() {
  return `RSN-${++counter}`;
}

export function generateReasoning(
  ds: ParsedDataset,
  profile: DataProfile
): GroundTruthQuestion[] {
  counter = 0;
  const questions: GroundTruthQuestion[] = [];
  const sortedPatients = [...ds.patients].sort((a, b) => a.id.localeCompare(b.id));

  // Build per-patient condition sets for reuse
  const patientConditionSets = new Map<string, Set<string>>();
  for (const c of ds.conditions) {
    let set = patientConditionSets.get(c.patientId);
    if (!set) {
      set = new Set();
      patientConditionSets.set(c.patientId, set);
    }
    set.add(c.description);
  }

  // ──────────────────────────────────────────────────────────────────
  // 1. Diabetes control assessment from A1C trend
  //    Requires: retrieving A1C history + interpreting clinical thresholds
  // ──────────────────────────────────────────────────────────────────
  let q1Count = 0;
  for (const patient of sortedPatients) {
    if (q1Count >= 20) break;
    const condSet = patientConditionSets.get(patient.id);
    if (!condSet) continue;
    const hasDiabetes = [...condSet].some((c) => c.toLowerCase().includes("diabetes"));
    if (!hasDiabetes) continue;

    const obs = ds.byPatient.observations.get(patient.id);
    if (!obs) continue;
    const a1cValues = obs
      .filter((o) => o.code === "4548-4" && o.type === "numeric")
      .sort((a, b) => a.date.localeCompare(b.date));
    if (a1cValues.length < 3) continue;

    const recent = a1cValues.slice(-5);
    // Skip patients with implausible A1C values (Synthea artifact)
    if (recent.some((o) => !isPlausibleValue("4548-4", o.value))) continue;
    const values = recent.map((o) => parseFloat(o.value));
    const lastVal = values[values.length - 1];
    const firstVal = values[0];

    let assessment: string;
    if (lastVal < 7.0) {
      assessment = "Well-controlled";
    } else if (lastVal >= 7.0 && lastVal < 9.0) {
      assessment = lastVal > firstVal ? "Worsening control" : "Suboptimal but stable/improving";
    } else {
      assessment = "Poorly controlled";
    }

    const trendData = recent.map((o) => `${o.date.slice(0, 10)}: ${o.value}%`);
    questions.push({
      id: id(),
      type: "reasoning",
      question: `Assess the diabetes control for patient ${patient.firstName} ${patient.lastName} (ID: ${patient.id}) based on their A1C history.`,
      answer: `${assessment}. A1C values: ${trendData.join(", ")}. Most recent: ${lastVal}%.`,
      patientIds: [patient.id],
      domain: "diabetes",
      supportingRecordIds: recent.map((o) => o.id),
    });

    q1Count++;
  }

  // ──────────────────────────────────────────────────────────────────
  // 2. CKD progression risk from creatinine + eGFR trends
  //    Requires: correlating two lab series + staging classification
  // ──────────────────────────────────────────────────────────────────
  let q2Count = 0;
  for (const patient of sortedPatients) {
    if (q2Count >= 20) break;
    const condSet = patientConditionSets.get(patient.id);
    if (!condSet) continue;
    const hasCKD = [...condSet].some((c) => c.toLowerCase().includes("chronic kidney disease"));
    if (!hasCKD) continue;

    const obs = ds.byPatient.observations.get(patient.id);
    if (!obs) continue;

    const creatinine = obs
      .filter((o) => o.code === "2160-0" && o.type === "numeric")
      .sort((a, b) => a.date.localeCompare(b.date));
    const egfr = obs
      .filter((o) => o.code === "33914-3" && o.type === "numeric")
      .sort((a, b) => a.date.localeCompare(b.date));

    if (creatinine.length < 2 && egfr.length < 2) continue;
    // Filter implausible values
    const plausibleCr = creatinine.filter((o) => isPlausibleValue("2160-0", o.value));
    const plausibleEgfr = egfr.filter((o) => isPlausibleValue("33914-3", o.value));
    if (plausibleCr.length < 2 && plausibleEgfr.length < 2) continue;

    const supportingIds: string[] = [];
    const parts: string[] = [];
    let crTrend = "stable";

    if (plausibleCr.length >= 2) {
      const recentCr = plausibleCr.slice(-3);
      const crFirst = parseFloat(recentCr[0].value);
      const crLast = parseFloat(recentCr[recentCr.length - 1].value);
      crTrend = crLast > crFirst * 1.1 ? "rising" : crLast < crFirst * 0.9 ? "falling" : "stable";
      parts.push(`Creatinine ${crTrend} (${recentCr.map((o) => `${o.date.slice(0, 10)}: ${o.value}`).join(", ")})`);
      supportingIds.push(...recentCr.map((o) => o.id));
    }

    // Determine eGFR-based CKD stage
    let egfrStage = 0; // 0 = unknown
    let egfrLast = 0;
    if (plausibleEgfr.length >= 2) {
      const recentEgfr = plausibleEgfr.slice(-3);
      egfrLast = parseFloat(recentEgfr[recentEgfr.length - 1].value);
      let stage: string;
      if (egfrLast >= 90) { stage = "Stage 1"; egfrStage = 1; }
      else if (egfrLast >= 60) { stage = "Stage 2"; egfrStage = 2; }
      else if (egfrLast >= 30) { stage = "Stage 3"; egfrStage = 3; }
      else if (egfrLast >= 15) { stage = "Stage 4"; egfrStage = 4; }
      else { stage = "Stage 5"; egfrStage = 5; }
      parts.push(`eGFR suggests ${stage} (latest: ${egfrLast.toFixed(1)})`);
      supportingIds.push(...recentEgfr.map((o) => o.id));
    }

    // Risk assessment: use BOTH eGFR stage and creatinine trend
    // Stage 4-5 or eGFR < 30 → High
    // Stage 3 or creatinine rising above 2.0 → Moderate-high
    // Stage 2 or creatinine > 1.5 → Moderate
    // Stage 1 (eGFR ≥ 90) → Low (regardless of creatinine)
    const crLastVal = plausibleCr.length > 0 ? parseFloat(plausibleCr[plausibleCr.length - 1].value) : 0;
    let risk: string;
    if (egfrStage >= 4) {
      risk = "High";
    } else if (egfrStage === 3 || (crLastVal > 2.0 && egfrStage !== 1)) {
      risk = "Moderate-high";
    } else if (egfrStage === 2 || (crLastVal > 1.5 && egfrStage !== 1)) {
      risk = "Moderate";
    } else if (egfrStage === 1 && crTrend === "rising") {
      risk = "Low-moderate (early stage, monitor creatinine trend)";
    } else {
      risk = "Low";
    }

    questions.push({
      id: id(),
      type: "reasoning",
      question: `Assess the CKD progression risk for patient ${patient.firstName} ${patient.lastName} (ID: ${patient.id}) based on their lab trends.`,
      answer: `${risk} risk. ${parts.join(". ")}.`,
      patientIds: [patient.id],
      domain: "renal",
      supportingRecordIds: supportingIds,
    });

    q2Count++;
  }

  // ──────────────────────────────────────────────────────────────────
  // 3. Potential drug interactions
  //    Requires: retrieving active med list + clinical pharmacology knowledge
  // ──────────────────────────────────────────────────────────────────
  const interactionPairs = [
    { drugs: ["Warfarin", "Aspirin"], risk: "Increased bleeding risk" },
    { drugs: ["ACE inhibitor", "Potassium"], risk: "Hyperkalemia risk" },
    { drugs: ["Metformin", "Contrast"], risk: "Lactic acidosis risk" },
    { drugs: ["NSAID", "ACE inhibitor"], risk: "Reduced antihypertensive effect and renal risk" },
    { drugs: ["Statin", "Fibrate"], risk: "Increased myopathy risk" },
    { drugs: ["Insulin", "Sulfonylurea"], risk: "Hypoglycemia risk" },
  ];

  let q3Count = 0;
  for (const patient of sortedPatients) {
    if (q3Count >= 20) break;
    const meds = ds.byPatient.medications.get(patient.id);
    if (!meds) continue;
    const activeMeds = meds.filter((m) => !m.stopDate);
    if (activeMeds.length < 2) continue;

    for (const pair of interactionPairs) {
      if (q3Count >= 20) break;
      const matchA = activeMeds.filter((m) =>
        m.description.toLowerCase().includes(pair.drugs[0].toLowerCase())
      );
      const matchB = activeMeds.filter((m) =>
        m.description.toLowerCase().includes(pair.drugs[1].toLowerCase())
      );
      if (matchA.length === 0 || matchB.length === 0) continue;

      questions.push({
        id: id(),
        type: "reasoning",
        question: `Are there any potential drug interactions for patient ${patient.firstName} ${patient.lastName} (ID: ${patient.id})?`,
        answer: `Yes. ${pair.risk}: ${matchA[0].description} + ${matchB[0].description}.`,
        patientIds: [patient.id],
        domain: "medications",
        supportingRecordIds: [matchA[0].id, matchB[0].id],
      });
  
      q3Count++;
      break;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // 4. Treatment plan consistency with guidelines
  //    Requires: cross-referencing conditions with active medications
  //    against standard-of-care guidelines
  // ──────────────────────────────────────────────────────────────────
  let q4Count = 0;
  for (const patient of sortedPatients) {
    if (q4Count >= 20) break;
    const condSet = patientConditionSets.get(patient.id);
    if (!condSet) continue;

    const hasDiabetes = [...condSet].some((c) => c.toLowerCase().includes("diabetes"));
    const hasHypertension = [...condSet].some((c) => c.toLowerCase().includes("hypertension"));
    const hasHyperlipidemia = [...condSet].some((c) =>
      c.toLowerCase().includes("hyperlipidemia") || c.toLowerCase().includes("hypercholes")
    );
    if (!hasDiabetes && !hasHypertension && !hasHyperlipidemia) continue;

    const meds = ds.byPatient.medications.get(patient.id);
    const activeMeds = meds?.filter((m) => !m.stopDate) ?? [];
    const medDescs = activeMeds.map((m) => m.description.toLowerCase());

    const findings: string[] = [];
    const supportingIds: string[] = [];

    if (hasDiabetes) {
      const onMetformin = medDescs.some((d) => d.includes("metformin"));
      const onInsulin = medDescs.some((d) => d.includes("insulin"));
      if (onMetformin || onInsulin) {
        findings.push(`Diabetes: Treated with ${onMetformin ? "metformin" : ""}${onMetformin && onInsulin ? " and " : ""}${onInsulin ? "insulin" : ""} (guideline-concordant)`);
      } else {
        findings.push("Diabetes: No standard diabetes medication found (potential gap)");
      }
    }

    if (hasHypertension) {
      const onAntihypertensive = medDescs.some(
        (d) => d.includes("lisinopril") || d.includes("amlodipine") || d.includes("losartan") || d.includes("hydrochlorothiazide") || d.includes("valsartan")
      );
      if (onAntihypertensive) {
        findings.push("Hypertension: On antihypertensive (guideline-concordant)");
      } else {
        findings.push("Hypertension: No standard antihypertensive found (potential gap)");
      }
    }

    if (hasHyperlipidemia) {
      const onStatin = medDescs.some(
        (d) => d.includes("statin") || d.includes("simvastatin") || d.includes("atorvastatin") || d.includes("rosuvastatin")
      );
      if (onStatin) {
        findings.push("Hyperlipidemia: On statin therapy (guideline-concordant)");
      } else {
        findings.push("Hyperlipidemia: No statin found (potential gap)");
      }
    }

    if (findings.length === 0) continue;

    supportingIds.push(...activeMeds.map((m) => m.id));
    questions.push({
      id: id(),
      type: "reasoning",
      question: `Evaluate the treatment plan consistency for patient ${patient.firstName} ${patient.lastName} (ID: ${patient.id}) against clinical guidelines.`,
      answer: findings.join(". ") + ".",
      patientIds: [patient.id],
      domain: "guidelines",
      supportingRecordIds: supportingIds,
    });

    q4Count++;
  }

  // ──────────────────────────────────────────────────────────────────
  // 5. Cardiovascular risk synthesis
  //    Requires: combining BP + cholesterol + BMI + conditions to form
  //    a multi-factor risk assessment. Genuine multi-data-point reasoning.
  // ──────────────────────────────────────────────────────────────────
  let q5Count = 0;
  for (const patient of sortedPatients) {
    if (q5Count >= 20) break;

    const obs = ds.byPatient.observations.get(patient.id);
    if (!obs) continue;
    const condSet = patientConditionSets.get(patient.id);

    // Need at least BP + cholesterol + one more factor
    const sbp = obs
      .filter((o) => o.code === "8480-6" && o.type === "numeric")
      .sort((a, b) => b.date.localeCompare(a.date));
    const chol = obs
      .filter((o) => o.code === "2093-3" && o.type === "numeric")
      .sort((a, b) => b.date.localeCompare(a.date));
    const bmi = obs
      .filter((o) => o.code === "39156-5" && o.type === "numeric")
      .sort((a, b) => b.date.localeCompare(a.date));

    if (sbp.length === 0 || chol.length === 0) continue;

    // Filter implausible vitals/labs
    const plausibleSbp = sbp.filter((o) => isPlausibleValue("8480-6", o.value));
    const plausibleChol = chol.filter((o) => isPlausibleValue("2093-3", o.value));
    const plausibleBmi = bmi.filter((o) => isPlausibleValue("39156-5", o.value));
    if (plausibleSbp.length === 0 || plausibleChol.length === 0) continue;

    const sbpVal = parseFloat(plausibleSbp[0].value);
    // Skip hypotensive readings — SBP < 90 is clinically alarming but not a CV risk factor
    if (sbpVal < 90) continue;
    const cholVal = parseFloat(plausibleChol[0].value);
    const bmiVal = plausibleBmi.length > 0 ? parseFloat(plausibleBmi[0].value) : null;

    const supportingIds = [plausibleSbp[0].id, plausibleChol[0].id];
    if (plausibleBmi.length > 0) supportingIds.push(plausibleBmi[0].id);

    // Build risk factors
    const riskFactors: string[] = [];
    if (sbpVal >= 140) riskFactors.push(`elevated BP (${sbpVal} mmHg)`);
    if (cholVal >= 240) riskFactors.push(`high total cholesterol (${cholVal} mg/dL)`);
    else if (cholVal >= 200) riskFactors.push(`borderline cholesterol (${cholVal} mg/dL)`);
    if (bmiVal !== null && bmiVal >= 30) riskFactors.push(`obesity (BMI ${bmiVal.toFixed(1)})`);
    if (condSet) {
      if ([...condSet].some((c) => c.toLowerCase().includes("diabetes"))) riskFactors.push("diabetes");
      if ([...condSet].some((c) => c.toLowerCase().includes("hypertension"))) riskFactors.push("hypertension diagnosis");
    }

    // Need at least 2 risk factors to make this a real reasoning question
    if (riskFactors.length < 2) continue;

    const riskLevel = riskFactors.length >= 4 ? "High" : riskFactors.length >= 3 ? "Moderate-high" : "Moderate";
    const dbp = obs.filter((o) => o.code === "8462-4" && o.type === "numeric" && isPlausibleValue("8462-4", o.value)).sort((a, b) => b.date.localeCompare(a.date));
    const answer = `${riskLevel} cardiovascular risk. Risk factors: ${riskFactors.join(", ")}. Latest BP: ${sbpVal}/${dbp[0]?.value ?? "N/A"} mmHg, Total cholesterol: ${cholVal} mg/dL${bmiVal !== null ? `, BMI: ${bmiVal.toFixed(1)}` : ""}.`;

    questions.push({
      id: id(),
      type: "reasoning",
      question: `What is the overall cardiovascular risk profile for patient ${patient.firstName} ${patient.lastName} (ID: ${patient.id}) based on their vitals, labs, and conditions?`,
      answer,
      patientIds: [patient.id],
      domain: "cardiovascular",
      supportingRecordIds: supportingIds,
    });

    q5Count++;
  }

  // ──────────────────────────────────────────────────────────────────
  // 6. Condition-medication temporal concordance
  //    Requires: checking whether medication was started at or near
  //    the time of diagnosis, and whether it's still active.
  //    Tests reasoning about treatment appropriateness over time.
  // ──────────────────────────────────────────────────────────────────
  const concordanceTargets = [
    { condition: "Diabetes", expectedMeds: ["metformin", "insulin", "glipizide", "sitagliptin"], condDomain: "diabetes" },
    { condition: "Hypertension", expectedMeds: ["lisinopril", "amlodipine", "losartan", "hydrochlorothiazide", "valsartan"], condDomain: "cardiovascular" },
    { condition: "Hyperlipidemia", expectedMeds: ["atorvastatin", "simvastatin", "rosuvastatin", "pravastatin"], condDomain: "cardiovascular" },
    { condition: "Asthma", expectedMeds: ["albuterol", "fluticasone", "montelukast", "budesonide"], condDomain: "respiratory" },
  ];

  let q6Count = 0;
  for (const patient of sortedPatients) {
    if (q6Count >= 20) break;

    const conds = ds.byPatient.conditions.get(patient.id);
    const meds = ds.byPatient.medications.get(patient.id);
    if (!conds || !meds) continue;

    for (const target of concordanceTargets) {
      if (q6Count >= 20) break;
      const matchingCond = conds.find((c) =>
        c.description.toLowerCase().includes(target.condition.toLowerCase())
      );
      if (!matchingCond) continue;

      const diagDate = new Date(matchingCond.startDate);
      const relevantMeds = meds.filter((m) =>
        target.expectedMeds.some((em) => m.description.toLowerCase().includes(em))
      );

      const supportingIds = [matchingCond.id, ...relevantMeds.map((m) => m.id)];

      let answer: string;
      if (relevantMeds.length === 0) {
        answer = `No standard ${target.condition.toLowerCase()} medication found despite ${matchingCond.description} diagnosis on ${matchingCond.startDate.slice(0, 10)}. Potential treatment gap.`;
      } else {
        const firstMed = relevantMeds.sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
        const medStartDate = new Date(firstMed.startDate);
        const daysDiff = Math.round((medStartDate.getTime() - diagDate.getTime()) / (1000 * 60 * 60 * 24));
        const stillActive = relevantMeds.some((m) => !m.stopDate);
        const activeStatus = stillActive ? "currently active" : "discontinued";

        if (daysDiff <= 30) {
          answer = `Timely treatment. ${firstMed.description} started ${daysDiff} days after ${matchingCond.description} diagnosis (${matchingCond.startDate.slice(0, 10)}). Treatment is ${activeStatus}.`;
        } else {
          answer = `Delayed treatment. ${firstMed.description} started ${daysDiff} days after ${matchingCond.description} diagnosis (${matchingCond.startDate.slice(0, 10)}). Treatment is ${activeStatus}.`;
        }
      }

      questions.push({
        id: id(),
        type: "reasoning",
        question: `Was treatment for ${matchingCond.description} initiated in a timely manner for patient ${patient.firstName} ${patient.lastName} (ID: ${patient.id}), and is it still active?`,
        answer,
        patientIds: [patient.id],
        domain: target.condDomain,
        supportingRecordIds: supportingIds,
      });
  
      q6Count++;
      break;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // 7. Multi-condition comorbidity burden assessment
  //    Requires: counting and categorizing a patient's active conditions,
  //    medications, and recent encounters to assess overall clinical complexity
  // ──────────────────────────────────────────────────────────────────
  let q7Count = 0;
  for (const patient of sortedPatients) {
    if (q7Count >= 20) break;

    const conds = ds.byPatient.conditions.get(patient.id);
    if (!conds) continue;
    const activeConds = conds.filter((c) => !c.stopDate);
    if (activeConds.length < 3) continue;

    const meds = ds.byPatient.medications.get(patient.id);
    const activeMeds = meds?.filter((m) => !m.stopDate) ?? [];
    const encs = ds.byPatient.encounters.get(patient.id);
    const recentEncs = encs?.filter((e) => {
      const d = new Date(e.startDate);
      return d.getFullYear() >= 2025;
    }) ?? [];

    const supportingIds = [
      ...activeConds.map((c) => c.id),
      ...activeMeds.slice(0, 5).map((m) => m.id),
    ];

    const condNames = [...new Set(activeConds.map((c) => c.description))].sort();
    const chronicCount = condNames.length;
    const medCount = activeMeds.length;
    const encCount = recentEncs.length;

    const complexity = chronicCount >= 6 || (chronicCount >= 4 && medCount >= 5)
      ? "High"
      : chronicCount >= 3 || medCount >= 3
        ? "Moderate"
        : "Low";

    const answer = `${complexity} clinical complexity. ${chronicCount} active conditions: ${condNames.join("; ")}. ${medCount} active medications. ${encCount} encounters since 2025. ${medCount >= 5 ? "Polypharmacy concern." : ""}`;

    questions.push({
      id: id(),
      type: "reasoning",
      question: `Assess the overall comorbidity burden and clinical complexity for patient ${patient.firstName} ${patient.lastName} (ID: ${patient.id}).`,
      answer: answer.trim(),
      patientIds: [patient.id],
      domain: "general",
      supportingRecordIds: supportingIds,
    });

    q7Count++;
  }

  return questions;
}
