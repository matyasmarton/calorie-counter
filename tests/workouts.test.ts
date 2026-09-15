/**
 * Workout burn math: the fixed precedence (manual → Keytel HR → MET), the
 * kJ→kcal conversion, the low-heart-rate fall-through, and the rejections.
 */
import { ValidationError } from '@/domain/errors';
import { MET_BY_TYPE, estimateWorkoutCalories, resolveAge } from '@/domain/workouts';
import { describe, expect, it } from 'vitest';

const base = {
  workoutType: 'running',
  durationMin: 30,
  avgHr: null,
  weightKg: null,
  age: null,
  sex: null,
  manualCalories: null,
} as const;

describe('estimateWorkoutCalories', () => {
  it('uses the Keytel male regression (kJ/min converted to kcal) when HR, weight, age and sex are known', () => {
    // -55.0969 + 0.6309×150 + 0.1988×75 + 0.2017×36 = 61.71 kJ/min
    // 61.71 / 4.184 = 14.75 kcal/min × 30 min = 442.5 → 442
    const result = estimateWorkoutCalories({
      ...base,
      avgHr: 150,
      weightKg: 75,
      age: 36,
      sex: 'male',
    });
    expect(result).toEqual({ calories: 442, source: 'hr-estimate' });
  });

  it('uses the Keytel female regression', () => {
    // -20.4022 + 0.4472×150 - 0.1263×60 + 0.074×30 = 41.32 kJ/min
    // 41.32 / 4.184 = 9.876 kcal/min × 45 min = 444.4 → 444
    const result = estimateWorkoutCalories({
      ...base,
      durationMin: 45,
      avgHr: 150,
      weightKg: 60,
      age: 30,
      sex: 'female',
    });
    expect(result).toEqual({ calories: 444, source: 'hr-estimate' });
  });

  it('keeps the HR estimate in a sane range (no kJ/kcal mix-up)', () => {
    // A 30-minute run at 150 bpm is a few hundred kcal, never ~1,800.
    const { calories } = estimateWorkoutCalories({ ...base, avgHr: 150, weightKg: 75, age: 36, sex: 'male' });
    expect(calories).toBeGreaterThan(300);
    expect(calories).toBeLessThan(600);
  });

  it('falls back to the MET estimate when any HR input is missing', () => {
    // 9.8 MET × 3.5 × 75 kg / 200 = 12.86 kcal/min × 30 min = 385.9 → 386
    expect(
      estimateWorkoutCalories({ ...base, avgHr: 150, weightKg: 75, age: 36, sex: null }),
    ).toEqual({ calories: 386, source: 'met-estimate' });
    expect(
      estimateWorkoutCalories({ ...base, avgHr: 150, weightKg: 75, age: null, sex: 'male' }),
    ).toEqual({ calories: 386, source: 'met-estimate' });
    expect(
      estimateWorkoutCalories({ ...base, avgHr: null, weightKg: 75, age: 36, sex: 'male' }),
    ).toEqual({ calories: 386, source: 'met-estimate' });
  });

  it('matches the MET value of each built-in type', () => {
    const yoga = estimateWorkoutCalories({ ...base, workoutType: 'yoga', durationMin: 60, weightKg: 75 });
    expect(yoga).toEqual({ calories: Math.round(((MET_BY_TYPE.yoga! * 3.5 * 75) / 200) * 60), source: 'met-estimate' });
    expect(MET_BY_TYPE.other).toBeGreaterThan(0);
    // case/whitespace insensitive lookup
    expect(estimateWorkoutCalories({ ...base, workoutType: ' Running ', weightKg: 75 })).toEqual({
      calories: 386,
      source: 'met-estimate',
    });
  });

  it('lets an explicit manual value win over every estimate', () => {
    expect(
      estimateWorkoutCalories({
        ...base,
        avgHr: 150,
        weightKg: 75,
        age: 36,
        sex: 'male',
        manualCalories: 300,
      }),
    ).toEqual({ calories: 300, source: 'manual' });
    // 0 is a legitimate manual value (e.g. a session the user counts as nothing)
    expect(estimateWorkoutCalories({ ...base, manualCalories: 0 })).toEqual({
      calories: 0,
      source: 'manual',
    });
  });

  it('falls through to MET when the HR reading is too low to be usable', () => {
    // At 50 bpm the male regression is negative — never report negative burn.
    const low = estimateWorkoutCalories({ ...base, avgHr: 50, weightKg: 75, age: 36, sex: 'male' });
    expect(low).toEqual({ calories: 386, source: 'met-estimate' });
  });

  it('rejects inputs that cannot produce any estimate', () => {
    // known type but no weight (and no usable HR inputs) → nothing to estimate from
    expect(() => estimateWorkoutCalories({ ...base, weightKg: null })).toThrow(ValidationError);
    // unknown type and no weight → same
    expect(() => estimateWorkoutCalories({ ...base, workoutType: 'kayaking' })).toThrow(ValidationError);
    expect(() => estimateWorkoutCalories({ ...base, workoutType: 'kayaking', weightKg: 75 })).toThrow(
      /enter calories manually/i,
    );
  });

  it('rejects a non-positive duration and negative manual calories', () => {
    expect(() => estimateWorkoutCalories({ ...base, durationMin: 0, weightKg: 75 })).toThrow(ValidationError);
    expect(() => estimateWorkoutCalories({ ...base, durationMin: Number.NaN, weightKg: 75 })).toThrow(
      ValidationError,
    );
    expect(() => estimateWorkoutCalories({ ...base, manualCalories: -5 })).toThrow(ValidationError);
  });

  it('scales linearly with duration', () => {
    const half = estimateWorkoutCalories({ ...base, durationMin: 15, weightKg: 75 });
    const full = estimateWorkoutCalories({ ...base, durationMin: 30, weightKg: 75 });
    expect(full.calories - half.calories).toBe(half.calories);
  });
});

describe('resolveAge', () => {
  it('derives age in years at the given date', () => {
    expect(resolveAge(1990, '2026-08-17')).toBe(36);
    expect(resolveAge(2000, '2026-01-01')).toBe(26);
  });

  it('returns null when no birth year is stored', () => {
    expect(resolveAge(null, '2026-08-17')).toBeNull();
  });

  it('rejects an invalid anchor date', () => {
    expect(() => resolveAge(1990, '2026-13-01')).toThrow(RangeError);
  });
});
