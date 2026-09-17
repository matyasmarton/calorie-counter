/**
 * Basal metabolic rate — the calories the body burns just existing.
 *
 * Mifflin-St Jeor (1990), the equation the Academy of Nutrition and Dietetics
 * recommends over Harris-Benedict for modern adults:
 *
 *   men:   10 × kg + 6.25 × cm − 5 × age + 5
 *   women: 10 × kg + 6.25 × cm − 5 × age − 161
 *
 * Sex is the one input the app may not have: the profile lets it be
 * undisclosed, so the two constants are averaged for that case and the resting
 * burn depends on exactly the weight, height and age that are on file.
 *
 * This is a baseline, never a target. It deliberately carries no activity
 * factor — the Activity tab adds the burn the user actually logged on top, and
 * folding an activity multiplier in here would count it twice.
 */
import { ValidationError } from './errors';
import type { Sex } from './types';

/**
 * The Mifflin-St Jeor sex constants in kcal/day. `unspecified` is the mean of
 * the male and female constants: with no sex on file the resting burn is still
 * worth reporting, and the mean keeps that estimate unbiased either way.
 */
const SEX_CONSTANT: Record<'male' | 'female' | 'unspecified', number> = {
  male: 5,
  female: -161,
  unspecified: -78,
};

export interface BmrInput {
  weightKg: number;
  heightCm: number;
  /** Whole years at the day being reported on — see `resolveAge`. */
  age: number;
  /** Null when the profile does not disclose it. */
  sex: Sex | null;
}

/**
 * Resting burn in whole kcal/day.
 *
 * Throws `ValidationError` for values the equation cannot use: the caller owns
 * the "is there enough data on file" question and should not call this until
 * weight, height and age are all known.
 */
export function basalMetabolicRate({ weightKg, heightCm, age, sex }: BmrInput): number {
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    throw new ValidationError(`Weight must be a positive number of kilograms (got ${weightKg})`);
  }
  if (!Number.isFinite(heightCm) || heightCm <= 0) {
    throw new ValidationError(`Height must be a positive number of centimetres (got ${heightCm})`);
  }
  if (!Number.isInteger(age) || age < 0 || age > 130) {
    throw new ValidationError(`Age must be a whole number of years between 0 and 130 (got ${age})`);
  }
  return Math.round(10 * weightKg + 6.25 * heightCm - 5 * age + SEX_CONSTANT[sex ?? 'unspecified']);
}
