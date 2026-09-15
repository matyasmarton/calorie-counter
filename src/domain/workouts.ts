/**
 * Burn math for manually logged workouts.
 *
 * One fixed precedence decides the calorie value, and the source that produced
 * it is snapshotted on the row (never recomputed later from changed inputs):
 *
 *   1. an explicit manual value wins outright;
 *   2. else the Keytel et al. (2005) heart-rate regression, when average HR,
 *      weight, age and sex are all known;
 *   3. else a MET estimate, when the workout type is known and weight is known;
 *   4. else the write is rejected and the user must enter calories manually.
 *
 * Peak HR is stored and displayed only — it never enters a formula.
 */
import { parseDateKey } from './dates';
import { ValidationError } from './errors';
import type { Sex, WorkoutCaloriesSource } from './types';

/**
 * Compendium of Physical Activities MET values by workout type. The activity
 * tab's picker is built from these keys, so every offered type has an estimate.
 */
export const MET_BY_TYPE: Record<string, number> = {
  running: 9.8,
  cycling: 7.5,
  swimming: 8.0,
  walking: 3.8,
  strength: 6.0,
  yoga: 3.0,
  rowing: 7.0,
  hiking: 6.0,
  dancing: 5.5,
  other: 5.0,
};

/**
 * The Keytel (2005) regressions predict kJ/min, not kcal/min: at typical
 * workout heart rates the raw result is ~4.2× the true kilocalorie value, so
 * it is converted before it is ever shown as calories.
 */
const KJ_PER_KCAL = 4.184;

export interface WorkoutEnergyInput {
  workoutType: string;
  durationMin: number;
  avgHr: number | null;
  weightKg: number | null;
  /** Age in whole years at the workout date (see `resolveAge`). */
  age: number | null;
  sex: Sex | null;
  /** Explicit override; null lets the HR/MET estimate decide. */
  manualCalories: number | null;
}

export interface WorkoutEnergy {
  /** Whole calories burned. */
  calories: number;
  source: WorkoutCaloriesSource;
}

/** Keytel et al. (2005) energy expenditure in kcal/min (may be <= 0 at low HR). */
function keytelKcalPerMinute(avgHr: number, weightKg: number, age: number, sex: Sex): number {
  const kjPerMin =
    sex === 'male'
      ? -55.0969 + 0.6309 * avgHr + 0.1988 * weightKg + 0.2017 * age
      : -20.4022 + 0.4472 * avgHr - 0.1263 * weightKg + 0.074 * age;
  return kjPerMin / KJ_PER_KCAL;
}

/** MET kcal/min: MET × 3.5 × kg / 200 (the standard 1-MET ≈ 3.5 ml O₂/kg/min form). */
function metKcalPerMinute(met: number, weightKg: number): number {
  return (met * 3.5 * weightKg) / 200;
}

/**
 * Estimate a workout's calories with the precedence documented at the top of
 * this module. Throws `ValidationError` when the inputs cannot produce any
 * estimate — the caller (or the user) must supply calories manually then.
 */
export function estimateWorkoutCalories(input: WorkoutEnergyInput): WorkoutEnergy {
  const { workoutType, durationMin, avgHr, weightKg, age, sex, manualCalories } = input;

  if (!Number.isFinite(durationMin) || durationMin <= 0) {
    throw new ValidationError(`Duration must be a positive number of minutes (got ${durationMin})`);
  }

  if (manualCalories != null) {
    if (!Number.isFinite(manualCalories) || manualCalories < 0) {
      throw new ValidationError(`Calories must be a non-negative number (got ${manualCalories})`);
    }
    return { calories: Math.round(manualCalories), source: 'manual' };
  }

  if (avgHr != null && weightKg != null && age != null && sex != null) {
    const perMinute = keytelKcalPerMinute(avgHr, weightKg, age, sex);
    // A resting-range heart rate can push the regression below zero; that is an
    // unusable HR reading, so fall through to the MET estimate rather than
    // record a negative burn that would corrupt the day's energy balance.
    if (perMinute > 0) {
      return { calories: Math.round(perMinute * durationMin), source: 'hr-estimate' };
    }
  }

  const met = MET_BY_TYPE[workoutType.trim().toLowerCase()];
  if (met != null && weightKg != null) {
    return { calories: Math.round(metKcalPerMinute(met, weightKg) * durationMin), source: 'met-estimate' };
  }

  throw new ValidationError(
    'Cannot estimate calories — add your weight and profile age for a heart-rate estimate, pick a known workout type for a MET estimate, or enter calories manually',
  );
}

/**
 * Age in whole years at `anchorDate`. Only the birth year is stored, so the
 * birthday is assumed to have passed: the result can be off by one year, which
 * is far inside the error of the HR regression it feeds.
 */
export function resolveAge(birthYear: number | null, anchorDate: string): number | null {
  if (birthYear == null) return null;
  const dt = parseDateKey(anchorDate);
  if (!dt) throw new RangeError(`invalid date key: ${anchorDate}`);
  return dt.getFullYear() - birthYear;
}
