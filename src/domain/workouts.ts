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
 * Compendium of Physical Activities MET values by workout type, taken from the
 * 2024 Adult Compendium (pacompendium.com). The trailing comment on each row
 * is the compendium's specific-activity code and description, so every number
 * is checkable against the source rather than remembered. The activity tab's
 * picker is built from these keys, so every offered type has an estimate.
 *
 * Where an activity spans a wide intensity range, the row named "general" for
 * a self-selected pace is used (the alternatives are noted inline). This is
 * the MET path only — when heart-rate data is present it wins over these.
 */
export const MET_BY_TYPE: Record<string, number> = {
  running: 9.3, // 12050  Running, 6-6.3 mph (10 min/mile); jogging, self-selected 7.5 (12020)
  cycling: 7.0, // 01014  Bicycling, general; stationary general 6.8 (01200), 12-13.9 mph 8.0 (01030)
  swimming: 6.0, // 18310  Swimming, leisurely, not lap swimming, general; laps freestyle slow 5.8 (18240), fast 9.8 (18230)
  walking: 3.8, // 17190  Walking, 2.8-3.4 mph, level, moderate pace, firm surface
  strength: 6.0, // 02050  Resistance training (free weights/nautilus), vigorous effort; 8-15 reps 3.5 (02054)
  yoga: 2.3, // 02175  Yoga, general (Hatha 2.3 / 02150; Hot 3.0 / 02155; Power 4.0 / 02160)
  rowing: 7.3, // 02070  Rowing, stationary ergometer, general, vigorous effort (100-149 W 7.5 / 02072)
  hiking: 6.0, // 17080  Hiking, cross country; with a daypack 7.8 (17012)
  dancing: 5.5, // 03030  Ballroom dancing, fast; folk, moderate 5.0 (03033)
  jump_rope: 11.8, // 15551  Rope jumping, moderate pace, general, 100-120 skips/min, 2-foot skip; fast 12.3 (15550), slow 8.3 (15552)
  stairmaster: 9.3, // 02065  Stair treadmill ergometer, general (climbing stairs, general 6.8 / 17131)
  other: 5.0, // deliberate fallback: the midpoint of the moderate 3-6 MET band
};

/**
 * Display labels for the built-in types, in picker order. Types synced from
 * another device that are not in here fall back to a humanized key.
 */
export const WORKOUT_TYPE_LABELS: Record<string, string> = {
  running: 'Running',
  cycling: 'Cycling',
  swimming: 'Swimming',
  walking: 'Walking',
  strength: 'Strength training',
  yoga: 'Yoga',
  rowing: 'Rowing machine',
  hiking: 'Hiking',
  dancing: 'Dancing',
  jump_rope: 'Jump rope',
  stairmaster: 'Stairmaster',
  other: 'Other',
};

/** Human label for a workout type: the built-in one, else "snake_case" → "Snake case". */
export function workoutTypeLabel(type: string): string {
  const known = WORKOUT_TYPE_LABELS[type];
  if (known) return known;
  const spaced = type.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

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
