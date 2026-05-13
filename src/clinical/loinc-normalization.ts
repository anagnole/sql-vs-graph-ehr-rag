/**
 * LOINC-coded observation normalization tables.
 *
 * Covers the common labs that appear in clinical-reasoning questions. Reference
 * ranges are adult defaults (US, non-pregnant); boundary values come from
 * published clinical guidelines (ADA, AHA, NCEP ATP III, KDIGO, NKF).
 *
 * Adding a new LOINC: pick a canonical unit, write the converter, document the
 * normal/critical range source. Don't guess — omit the range if unsure.
 */

export interface UnitConversion {
  canonicalUnit: string;
  /** Convert from source unit (lowercased) to canonical unit. Return null if unknown. */
  toCanonical(value: number, sourceUnit: string): number | null;
}

export interface ReferenceRange {
  normalLow?: number;
  normalHigh?: number;
  criticalLow?: number;
  criticalHigh?: number;
  /** Short free-text citation of the guideline/source. */
  source: string;
}

export interface LoincSpec {
  code: string;
  shortName: string;
  conversion: UnitConversion;
  range?: ReferenceRange;
}

// ─── Identity conversion (when source unit already matches canonical) ─────
function identity(canonicalUnit: string, accepted: string[]): UnitConversion {
  const acceptedLc = accepted.map((u) => u.toLowerCase());
  return {
    canonicalUnit,
    toCanonical(value: number, sourceUnit: string): number | null {
      if (acceptedLc.includes(sourceUnit.toLowerCase())) return value;
      return null;
    },
  };
}

// ─── LOINC registry ───────────────────────────────────────────────────────
// Extend here as new labs appear in evaluation questions.
export const LOINC_SPECS: LoincSpec[] = [
  // Glucose — mg/dL canonical. mmol/L → mg/dL factor 18.0182.
  {
    code: "2339-0",
    shortName: "Glucose (serum)",
    conversion: {
      canonicalUnit: "mg/dL",
      toCanonical(v, u) {
        const lc = u.toLowerCase();
        if (lc === "mg/dl") return v;
        if (lc === "mmol/l") return v * 18.0182;
        return null;
      },
    },
    range: { normalLow: 70, normalHigh: 99, criticalLow: 40, criticalHigh: 400, source: "ADA 2024 (fasting)" },
  },
  // HbA1c — % (NGSP) canonical. IFCC mmol/mol → NGSP %: ngsp = 0.09148 * ifcc + 2.152.
  {
    code: "4548-4",
    shortName: "HbA1c",
    conversion: {
      canonicalUnit: "%",
      toCanonical(v, u) {
        const lc = u.toLowerCase();
        if (lc === "%") return v;
        if (lc === "mmol/mol") return 0.09148 * v + 2.152;
        return null;
      },
    },
    range: { normalLow: 4.0, normalHigh: 5.6, criticalHigh: 14.0, source: "ADA 2024 (normal <5.7%, diabetes ≥6.5%)" },
  },
  // Total cholesterol — mg/dL canonical. mmol/L → mg/dL factor 38.67.
  {
    code: "2093-3",
    shortName: "Total cholesterol",
    conversion: {
      canonicalUnit: "mg/dL",
      toCanonical(v, u) {
        const lc = u.toLowerCase();
        if (lc === "mg/dl") return v;
        if (lc === "mmol/l") return v * 38.67;
        return null;
      },
    },
    range: { normalHigh: 200, source: "NCEP ATP III (desirable <200 mg/dL)" },
  },
  // LDL cholesterol — mg/dL canonical.
  {
    code: "18262-6",
    shortName: "LDL cholesterol",
    conversion: {
      canonicalUnit: "mg/dL",
      toCanonical(v, u) {
        const lc = u.toLowerCase();
        if (lc === "mg/dl") return v;
        if (lc === "mmol/l") return v * 38.67;
        return null;
      },
    },
    range: { normalHigh: 100, source: "NCEP ATP III (optimal <100 mg/dL)" },
  },
  // HDL cholesterol — mg/dL canonical.
  {
    code: "2085-9",
    shortName: "HDL cholesterol",
    conversion: {
      canonicalUnit: "mg/dL",
      toCanonical(v, u) {
        const lc = u.toLowerCase();
        if (lc === "mg/dl") return v;
        if (lc === "mmol/l") return v * 38.67;
        return null;
      },
    },
    range: { normalLow: 40, source: "NCEP ATP III (low <40 mg/dL)" },
  },
  // Triglycerides — mg/dL canonical. mmol/L → mg/dL factor 88.57.
  {
    code: "2571-8",
    shortName: "Triglycerides",
    conversion: {
      canonicalUnit: "mg/dL",
      toCanonical(v, u) {
        const lc = u.toLowerCase();
        if (lc === "mg/dl") return v;
        if (lc === "mmol/l") return v * 88.57;
        return null;
      },
    },
    range: { normalHigh: 150, criticalHigh: 1000, source: "NCEP ATP III (normal <150 mg/dL); ≥1000 = acute pancreatitis risk" },
  },
  // Creatinine (serum) — mg/dL canonical. µmol/L → mg/dL factor 88.4.
  {
    code: "2160-0",
    shortName: "Creatinine (serum)",
    conversion: {
      canonicalUnit: "mg/dL",
      toCanonical(v, u) {
        const lc = u.toLowerCase();
        if (lc === "mg/dl") return v;
        if (lc === "umol/l" || lc === "µmol/l") return v / 88.4;
        return null;
      },
    },
    range: { normalLow: 0.6, normalHigh: 1.3, criticalHigh: 10.0, source: "KDIGO; varies by sex/muscle mass" },
  },
  // eGFR — mL/min/1.73m^2 (no unit conversions used in practice).
  {
    code: "33914-3",
    shortName: "eGFR",
    conversion: identity("mL/min/{1.73_m2}", ["ml/min/{1.73_m2}", "ml/min/1.73m2", "ml/min/1.73 m2"]),
    range: { normalLow: 90, criticalLow: 15, source: "KDIGO 2012 CKD staging (G1 ≥90; G5 <15)" },
  },
  // Systolic BP — mmHg canonical.
  {
    code: "8480-6",
    shortName: "Systolic BP",
    conversion: identity("mm[Hg]", ["mm[hg]", "mmhg"]),
    range: { normalHigh: 120, criticalLow: 80, criticalHigh: 180, source: "ACC/AHA 2017 (normal <120; hypertensive crisis ≥180)" },
  },
  // Diastolic BP — mmHg canonical.
  {
    code: "8462-4",
    shortName: "Diastolic BP",
    conversion: identity("mm[Hg]", ["mm[hg]", "mmhg"]),
    range: { normalHigh: 80, criticalLow: 50, criticalHigh: 120, source: "ACC/AHA 2017" },
  },
  // BMI — kg/m^2 canonical.
  {
    code: "39156-5",
    shortName: "BMI",
    conversion: identity("kg/m2", ["kg/m2", "kg/m^2"]),
    range: { normalLow: 18.5, normalHigh: 24.9, source: "WHO (underweight <18.5; normal 18.5-24.9; overweight 25-29.9; obese ≥30)" },
  },
  // Hemoglobin — g/dL canonical.
  {
    code: "718-7",
    shortName: "Hemoglobin",
    conversion: {
      canonicalUnit: "g/dL",
      toCanonical(v, u) {
        const lc = u.toLowerCase();
        if (lc === "g/dl") return v;
        if (lc === "g/l") return v / 10;
        if (lc === "mmol/l") return v * 1.611; // Hb MW ≈ 16114 g/mol, but practical factor
        return null;
      },
    },
    range: { normalLow: 12.0, normalHigh: 17.5, criticalLow: 7.0, source: "WHO (sex-specific: ♀ 12-15.5, ♂ 13.5-17.5)" },
  },
  // Potassium (serum) — mmol/L canonical. mEq/L is numerically identical.
  {
    code: "6298-4",
    shortName: "Potassium (serum)",
    conversion: identity("mmol/L", ["mmol/l", "meq/l", "mval/l"]),
    range: { normalLow: 3.5, normalHigh: 5.1, criticalLow: 2.5, criticalHigh: 6.5, source: "KDIGO" },
  },
  // Sodium (serum) — mmol/L canonical.
  {
    code: "2951-2",
    shortName: "Sodium (serum)",
    conversion: identity("mmol/L", ["mmol/l", "meq/l"]),
    range: { normalLow: 135, normalHigh: 145, criticalLow: 120, criticalHigh: 160, source: "Standard adult reference" },
  },
];

// ─── Lookup maps ──────────────────────────────────────────────────────────

const SPEC_BY_CODE = new Map<string, LoincSpec>();
for (const spec of LOINC_SPECS) SPEC_BY_CODE.set(spec.code, spec);

export function normalizeObservation(
  code: string,
  rawValue: string | number,
  rawUnit: string,
): { valueCanonical: number | null; unitCanonical: string | null } {
  const spec = SPEC_BY_CODE.get(code);
  if (!spec) return { valueCanonical: null, unitCanonical: null };

  const v = typeof rawValue === "number" ? rawValue : parseFloat(String(rawValue));
  if (!Number.isFinite(v)) return { valueCanonical: null, unitCanonical: spec.conversion.canonicalUnit };

  const converted = spec.conversion.toCanonical(v, String(rawUnit ?? ""));
  return {
    valueCanonical: converted,
    unitCanonical: spec.conversion.canonicalUnit,
  };
}

export function getReferenceRange(code: string): ReferenceRange | undefined {
  return SPEC_BY_CODE.get(code)?.range;
}

export function getLoincSpec(code: string): LoincSpec | undefined {
  return SPEC_BY_CODE.get(code);
}
