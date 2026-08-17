export type BmiCategory = 'underweight' | 'healthy' | 'overweight' | 'obesity';

export const BMI_ADULT_REFERENCE_DISCLAIMER =
  'BMI is a screening metric for adults only. It is not a diagnosis and does not assess body composition, muscle mass, age, or medical history.';

export interface BmiResult {
  bmi: number;
  category: BmiCategory;
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite, positive number (got ${value})`);
  }
}

/**
 * BMI = weightKg / (heightM ** 2), rounded to one decimal.
 * Rejects non-finite or non-positive inputs.
 */
export function calculateBmi(weightKg: number, heightCm: number): number {
  assertPositive(weightKg, 'weightKg');
  assertPositive(heightCm, 'heightCm');
  const heightM = heightCm / 100;
  return Math.round((weightKg / (heightM * heightM)) * 10) / 10;
}

/**
 * Standard adult BMI ranges:
 *   underweight < 18.5, healthy 18.5–24.9, overweight 25–29.9, obesity >= 30.
 */
export function classifyBmi(bmi: number): BmiCategory {
  if (!Number.isFinite(bmi)) throw new RangeError(`bmi must be finite (got ${bmi})`);
  if (bmi < 18.5) return 'underweight';
  if (bmi < 25) return 'healthy';
  if (bmi < 30) return 'overweight';
  return 'obesity';
}

/** Convenience: BMI + category in one validated call. */
export function bmiResult(weightKg: number, heightCm: number): BmiResult {
  const bmi = calculateBmi(weightKg, heightCm);
  return { bmi, category: classifyBmi(bmi) };
}

export const BMI_CATEGORY_LABELS: Record<BmiCategory, string> = {
  underweight: 'Underweight (<18.5)',
  healthy: 'Healthy (18.5–24.9)',
  overweight: 'Overweight (25–29.9)',
  obesity: 'Obesity (≥30)',
};
