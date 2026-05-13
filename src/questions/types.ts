export type QuestionType =
  | "simple-lookup"
  | "multi-hop"
  | "temporal"
  | "cohort"
  | "reasoning"
  | "negation"
  | "unanswerable";

export interface GroundTruthQuestion {
  id: string;
  type: QuestionType;
  question: string;
  answer: string;
  /** Patient IDs involved (empty for cohort questions spanning all patients) */
  patientIds: string[];
  /** Clinical domain tag for stratification */
  domain: string;
  /** Supporting record IDs for citation/hallucination checking */
  supportingRecordIds: string[];
}

/**
 * Plausibility bounds for lab values. Synthea sometimes generates values
 * outside physiological range (e.g., A1C 2.8%). Questions with implausible
 * values undermine clinical credibility and should be excluded.
 */
export const LAB_PLAUSIBILITY: Record<string, { min: number; max: number }> = {
  "4548-4":  { min: 4.0, max: 20.0 },   // Hemoglobin A1c (%)
  "8480-6":  { min: 70, max: 250 },      // Systolic BP (mmHg)
  "8462-4":  { min: 40, max: 150 },      // Diastolic BP (mmHg)
  "2160-0":  { min: 0.3, max: 15 },      // Creatinine (mg/dL)
  "33914-3": { min: 3, max: 200 },       // eGFR (mL/min)
  "2093-3":  { min: 80, max: 500 },      // Total Cholesterol (mg/dL)
  "39156-5": { min: 12, max: 70 },       // BMI
};

/** Returns true if the numeric observation value is clinically plausible. */
export function isPlausibleValue(code: string, value: string): boolean {
  const bounds = LAB_PLAUSIBILITY[code];
  if (!bounds) return true; // no bounds defined → accept
  const num = parseFloat(value);
  if (isNaN(num)) return true; // not numeric → accept
  return num >= bounds.min && num <= bounds.max;
}

/** Normalize observation units to consistent clinical notation. */
export function normalizeUnits(code: string, units: string): string {
  // eGFR: Synthea outputs both "mL/min" and "mL/min/{1.73_m2}" — standardize
  if (code === "33914-3") return "mL/min/1.73m2";
  return units;
}

export interface DataProfile {
  totalPatients: number;
  totalEncounters: number;
  /** condition description -> patient count */
  conditionCounts: Map<string, number>;
  /** observation code -> { description, patientCount } */
  observationCoverage: Map<string, { description: string; patientCount: number }>;
  /** medication description -> patient count */
  medicationCounts: Map<string, number>;
  /** [condA, condB] -> co-occurrence count */
  conditionCoOccurrences: Map<string, number>;
  /** encounter class -> count */
  encounterClassCounts: Map<string, number>;
}
