/**
 * Burn estimated from a day's step count.
 *
 * Distance first. Walking step length is taken as 0.415 × height for men and
 * 0.413 for women, the ratio pedometer algorithms default to; with no sex on
 * file the two are averaged. It is an approximation by nature — real stride
 * varies with pace, terrain and leg length — so the result is a reference
 * number, not a measurement, and an entered calorie value always wins over it.
 *
 * Energy next, from the ACSM walking equation (the same family as the
 * Compendium MET values in `workouts.ts`). ACSM puts the net oxygen cost of
 * level walking at 0.1 ml/kg/min per m/min of speed, and this app converts
 * oxygen to calories as `ml/kg/min × kg / 200`. Per kilometre that collapses to
 *
 *   0.1 × 1000 / 200 = 0.5 kcal per kg per km,
 *
 * independent of speed — which is why no duration is needed here. It is a *net*
 * figure: resting metabolism is counted separately as the day's baseline, so
 * folding it in would count the same calories twice.
 *
 * Age is deliberately absent: no walking-cost equation that can be cited has an
 * age term. It still reaches the day's total through the resting baseline,
 * which is recomputed from the profile's birth year.
 */
import { ValidationError } from './errors';
import type { Sex } from './types';

/** Step length as a fraction of standing height, by sex. */
const STEP_LENGTH_RATIO: Record<'male' | 'female' | 'unspecified', number> = {
  male: 0.415,
  female: 0.413,
  unspecified: 0.414,
};

/** Net kcal per kilogram per kilometre of level walking (see the module note). */
const NET_KCAL_PER_KG_KM = 0.5;

export interface StepCaloriesInput {
  /** Whole steps for the day. */
  steps: number;
  weightKg: number;
  heightCm: number;
  /** Null when the profile does not disclose it. */
  sex: Sex | null;
}

/** Step length in metres for a given height, or null when the height is unusable. */
export function stepLengthM(heightCm: number, sex: Sex | null): number {
  if (!Number.isFinite(heightCm) || heightCm <= 0) {
    throw new ValidationError(`Height must be a positive number of centimetres (got ${heightCm})`);
  }
  return (heightCm / 100) * STEP_LENGTH_RATIO[sex ?? 'unspecified'];
}

/**
 * The day's walking burn in whole kcal, net of resting metabolism.
 *
 * Throws `ValidationError` for values that cannot be used; the caller owns the
 * "is there enough on file" question and should only call this once the steps,
 * weight and height are known.
 */
export function estimateStepsCalories({ steps, weightKg, heightCm, sex }: StepCaloriesInput): number {
  if (!Number.isInteger(steps) || steps < 0) {
    throw new ValidationError(`Steps must be a whole, non-negative number (got ${steps})`);
  }
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    throw new ValidationError(`Weight must be a positive number of kilograms (got ${weightKg})`);
  }
  const distanceKm = (steps * stepLengthM(heightCm, sex)) / 1000;
  return Math.round(distanceKm * weightKg * NET_KCAL_PER_KG_KM);
}
