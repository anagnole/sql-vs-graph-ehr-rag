import type { ParsedDataset } from "../parser/types.js";
import type { DataProfile, GroundTruthQuestion } from "./types.js";

let counter = 0;
function id() {
  return `UNA-${++counter}`;
}

/**
 * Generate questions that CANNOT be answered from the EHR data.
 * Tests whether the system can recognize its own limitations and abstain
 * rather than hallucinate. Modeled after EHRSQL's unanswerable questions.
 *
 * Categories:
 * 1. Non-existent patients (fabricated names/IDs)
 * 2. Data types not in Synthea (genetic tests, imaging reports, clinical notes)
 * 3. Subjective/qualitative questions (patient satisfaction, quality of life)
 * 4. Future predictions requiring clinical judgment beyond data
 * 5. Conditions/labs that exist in medicine but not in this patient's record
 */
export function generateUnanswerable(
  ds: ParsedDataset,
  _profile: DataProfile
): GroundTruthQuestion[] {
  counter = 0;
  const questions: GroundTruthQuestion[] = [];
  const sortedPatients = [...ds.patients].sort((a, b) => a.id.localeCompare(b.id));

  // 1. Non-existent patients — fabricated IDs that look real
  const fakePatients = [
    { name: "Marcus Webb", id: "ffffffff-0000-0000-0000-000000000001" },
    { name: "Elena Vasquez", id: "ffffffff-0000-0000-0000-000000000002" },
    { name: "Hiroshi Tanaka", id: "ffffffff-0000-0000-0000-000000000003" },
    { name: "Priya Nair", id: "ffffffff-0000-0000-0000-000000000004" },
    { name: "Johan Bergström", id: "ffffffff-0000-0000-0000-000000000005" },
    { name: "Amaka Okafor", id: "ffffffff-0000-0000-0000-000000000006" },
  ];

  for (const fake of fakePatients) {
    questions.push({
      id: id(),
      type: "unanswerable",
      question: `What are the active conditions for patient ${fake.name} (ID: ${fake.id})?`,
      answer: "UNANSWERABLE: Patient not found in the database.",
      patientIds: [],
      domain: "non-existent-patient",
      supportingRecordIds: [],
    });
  }

  // 2. Data types not present in Synthea EHR
  const realPatient = sortedPatients[10]; // pick a real patient
  const realPatient2 = sortedPatients[25];
  const realPatient3 = sortedPatients[40];

  if (realPatient) {
    questions.push({
      id: id(),
      type: "unanswerable",
      question: `What were the findings on the most recent chest X-ray for patient ${realPatient.firstName} ${realPatient.lastName} (ID: ${realPatient.id})?`,
      answer: "UNANSWERABLE: Imaging reports/radiology findings are not available in this EHR system.",
      patientIds: [realPatient.id],
      domain: "missing-data-type",
      supportingRecordIds: [],
    });

    questions.push({
      id: id(),
      type: "unanswerable",
      question: `What genetic markers has patient ${realPatient.firstName} ${realPatient.lastName} (ID: ${realPatient.id}) been tested for?`,
      answer: "UNANSWERABLE: Genetic/genomic test data is not available in this EHR system.",
      patientIds: [realPatient.id],
      domain: "missing-data-type",
      supportingRecordIds: [],
    });
  }

  if (realPatient2) {
    questions.push({
      id: id(),
      type: "unanswerable",
      question: `What did the clinical notes say about patient ${realPatient2.firstName} ${realPatient2.lastName} (ID: ${realPatient2.id}) at their last visit?`,
      answer: "UNANSWERABLE: Free-text clinical notes are not available in this EHR system.",
      patientIds: [realPatient2.id],
      domain: "missing-data-type",
      supportingRecordIds: [],
    });
  }

  // 3. Subjective/qualitative questions
  if (realPatient3) {
    questions.push({
      id: id(),
      type: "unanswerable",
      question: `How would you rate patient ${realPatient3.firstName} ${realPatient3.lastName} (ID: ${realPatient3.id})'s quality of life?`,
      answer: "UNANSWERABLE: Quality of life assessments and patient-reported outcomes are not captured in this EHR system.",
      patientIds: [realPatient3.id],
      domain: "subjective",
      supportingRecordIds: [],
    });
  }

  // 4. Conditions that a real patient does NOT have (tests hallucination resistance)
  const conditionsToTest = [
    "HIV",
    "Parkinson's disease",
    "Multiple sclerosis",
    "Lupus",
    "Hepatitis C",
  ];

  let q4Count = 0;
  for (const patient of sortedPatients.slice(0, 100)) {
    if (q4Count >= 8) break;
    const conds = ds.byPatient.conditions.get(patient.id);
    const condDescs = conds?.map((c) => c.description.toLowerCase()) ?? [];

    for (const fakeCond of conditionsToTest) {
      if (q4Count >= 8) break;
      const hasIt = condDescs.some((d) => d.includes(fakeCond.toLowerCase()));
      if (hasIt) continue;

      questions.push({
        id: id(),
        type: "unanswerable",
        question: `When was patient ${patient.firstName} ${patient.lastName} (ID: ${patient.id}) diagnosed with ${fakeCond}?`,
        answer: `UNANSWERABLE: Patient has no record of ${fakeCond} in their medical history.`,
        patientIds: [patient.id],
        domain: "absent-condition",
        supportingRecordIds: [],
      });
      q4Count++;
      break;
    }
  }

  // 5. Future/predictive questions that require speculation
  const realPatient4 = sortedPatients[55];
  if (realPatient4) {
    questions.push({
      id: id(),
      type: "unanswerable",
      question: `What is the expected lifespan for patient ${realPatient4.firstName} ${realPatient4.lastName} (ID: ${realPatient4.id})?`,
      answer: "UNANSWERABLE: Life expectancy predictions cannot be determined from EHR data alone.",
      patientIds: [realPatient4.id],
      domain: "speculative",
      supportingRecordIds: [],
    });
  }

  const realPatient5 = sortedPatients[70];
  if (realPatient5) {
    questions.push({
      id: id(),
      type: "unanswerable",
      question: `Will patient ${realPatient5.firstName} ${realPatient5.lastName} (ID: ${realPatient5.id}) need hospitalization in the next year?`,
      answer: "UNANSWERABLE: Future hospitalization cannot be predicted from EHR data alone.",
      patientIds: [realPatient5.id],
      domain: "speculative",
      supportingRecordIds: [],
    });
  }

  // 6. External system questions (insurance, billing, referrals)
  const realPatient6 = sortedPatients[85];
  if (realPatient6) {
    questions.push({
      id: id(),
      type: "unanswerable",
      question: `What is the insurance coverage status for patient ${realPatient6.firstName} ${realPatient6.lastName} (ID: ${realPatient6.id})?`,
      answer: "UNANSWERABLE: Insurance coverage details are not available in this EHR system.",
      patientIds: [realPatient6.id],
      domain: "missing-data-type",
      supportingRecordIds: [],
    });
  }

  const realPatient7 = sortedPatients[95];
  if (realPatient7) {
    questions.push({
      id: id(),
      type: "unanswerable",
      question: `Has patient ${realPatient7.firstName} ${realPatient7.lastName} (ID: ${realPatient7.id}) been referred to a specialist?`,
      answer: "UNANSWERABLE: Referral records are not available in this EHR system.",
      patientIds: [realPatient7.id],
      domain: "missing-data-type",
      supportingRecordIds: [],
    });
  }

  // 7. More absent-condition hallucination traps (different question formats)
  const realPatient8 = sortedPatients[105];
  if (realPatient8) {
    const conds = ds.byPatient.conditions.get(realPatient8.id);
    const condDescs = conds?.map((c) => c.description.toLowerCase()) ?? [];
    if (!condDescs.some((d) => d.includes("cancer"))) {
      questions.push({
        id: id(),
        type: "unanswerable",
        question: `What cancer treatments has patient ${realPatient8.firstName} ${realPatient8.lastName} (ID: ${realPatient8.id}) received?`,
        answer: "UNANSWERABLE: Patient has no cancer diagnosis in their medical history.",
        patientIds: [realPatient8.id],
        domain: "absent-condition",
        supportingRecordIds: [],
      });
    }
  }

  const realPatient9 = sortedPatients[115];
  if (realPatient9) {
    questions.push({
      id: id(),
      type: "unanswerable",
      question: `What allergies does patient ${realPatient9.firstName} ${realPatient9.lastName} (ID: ${realPatient9.id}) have?`,
      answer: "UNANSWERABLE: Allergy data is not available in this EHR system.",
      patientIds: [realPatient9.id],
      domain: "missing-data-type",
      supportingRecordIds: [],
    });
  }

  // 8. Cohort-level unanswerable
  questions.push({
    id: id(),
    type: "unanswerable",
    question: "What is the 30-day readmission rate for patients with heart failure?",
    answer: "UNANSWERABLE: Readmission tracking and heart failure outcome metrics are not available in this EHR system.",
    patientIds: [],
    domain: "missing-data-type",
    supportingRecordIds: [],
  });

  questions.push({
    id: id(),
    type: "unanswerable",
    question: "What is the average patient satisfaction score across all providers?",
    answer: "UNANSWERABLE: Patient satisfaction scores are not captured in this EHR system.",
    patientIds: [],
    domain: "subjective",
    supportingRecordIds: [],
  });

  questions.push({
    id: id(),
    type: "unanswerable",
    question: "What is the average length of ICU stay across all admissions?",
    answer: "UNANSWERABLE: ICU-specific tracking is not captured separately in this EHR system.",
    patientIds: [],
    domain: "missing-data-type",
    supportingRecordIds: [],
  });

  questions.push({
    id: id(),
    type: "unanswerable",
    question: "Which patients have expressed dissatisfaction with their most recent provider?",
    answer: "UNANSWERABLE: Patient feedback and dissatisfaction indicators are not recorded in this EHR system.",
    patientIds: [],
    domain: "subjective",
    supportingRecordIds: [],
  });

  // 9. More missing-data-type at cohort level
  questions.push({
    id: id(),
    type: "unanswerable",
    question: "How many patients have a family history of breast cancer?",
    answer: "UNANSWERABLE: Family history is not captured in this EHR system.",
    patientIds: [],
    domain: "missing-data-type",
    supportingRecordIds: [],
  });

  questions.push({
    id: id(),
    type: "unanswerable",
    question: "What percentage of diabetic patients adhere to their prescribed medication regimen?",
    answer: "UNANSWERABLE: Medication adherence is not tracked in this EHR system.",
    patientIds: [],
    domain: "missing-data-type",
    supportingRecordIds: [],
  });

  // 10. More counterfactual / speculative at patient level
  const realPatient10 = sortedPatients[125];
  if (realPatient10) {
    questions.push({
      id: id(),
      type: "unanswerable",
      question: `If patient ${realPatient10.firstName} ${realPatient10.lastName} (ID: ${realPatient10.id}) had started statin therapy earlier, would their LDL be lower today?`,
      answer: "UNANSWERABLE: Counterfactual outcomes cannot be derived from observational EHR data alone.",
      patientIds: [realPatient10.id],
      domain: "counterfactual",
      supportingRecordIds: [],
    });
  }

  const realPatient11 = sortedPatients[140];
  if (realPatient11) {
    questions.push({
      id: id(),
      type: "unanswerable",
      question: `What would patient ${realPatient11.firstName} ${realPatient11.lastName}'s (ID: ${realPatient11.id}) blood pressure be if they were on standard hypertension protocol?`,
      answer: "UNANSWERABLE: Counterfactual predictions require controlled trials, not EHR data.",
      patientIds: [realPatient11.id],
      domain: "counterfactual",
      supportingRecordIds: [],
    });
  }

  // 11. Additional missing-data-type per patient
  const realPatient12 = sortedPatients[155];
  if (realPatient12) {
    questions.push({
      id: id(),
      type: "unanswerable",
      question: `What was the result of patient ${realPatient12.firstName} ${realPatient12.lastName}'s (ID: ${realPatient12.id}) most recent pathology report?`,
      answer: "UNANSWERABLE: Pathology reports are not available in this EHR system.",
      patientIds: [realPatient12.id],
      domain: "missing-data-type",
      supportingRecordIds: [],
    });
  }

  const realPatient13 = sortedPatients[170];
  if (realPatient13) {
    questions.push({
      id: id(),
      type: "unanswerable",
      question: `How does patient ${realPatient13.firstName} ${realPatient13.lastName} (ID: ${realPatient13.id}) feel about their current treatment plan?`,
      answer: "UNANSWERABLE: Patient-reported attitudes and preferences are not captured in this EHR system.",
      patientIds: [realPatient13.id],
      domain: "subjective",
      supportingRecordIds: [],
    });
  }

  // 12. Additional speculative / future
  const realPatient14 = sortedPatients[185];
  if (realPatient14) {
    questions.push({
      id: id(),
      type: "unanswerable",
      question: `Will patient ${realPatient14.firstName} ${realPatient14.lastName} (ID: ${realPatient14.id}) develop complications from their current conditions within 5 years?`,
      answer: "UNANSWERABLE: Long-term outcome predictions cannot be derived from EHR data alone.",
      patientIds: [realPatient14.id],
      domain: "speculative",
      supportingRecordIds: [],
    });
  }

  return questions;
}
