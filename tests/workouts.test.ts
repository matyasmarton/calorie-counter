/**
 * Workout burn math: the fixed precedence (manual → Keytel HR → MET), the
 * kJ→kcal conversion, the low-heart-rate fall-through, the rejections, and the
 * MET table's agreement with the 2024 Adult Compendium of Physical Activities.
 */
import { ValidationError } from '@/domain/errors';
import {
  MET_BY_TYPE,
  WORKOUT_TYPE_LABELS,
  estimateWorkoutCalories,
  resolveAge,
  workoutTypeLabel,
} from '@/domain/workouts';
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
    // 9.3 MET × 3.5 × 75 kg / 200 = 12.21 kcal/min × 30 min = 366.2 → 366
    expect(
      estimateWorkoutCalories({ ...base, avgHr: 150, weightKg: 75, age: 36, sex: null }),
    ).toEqual({ calories: 366, source: 'met-estimate' });
    expect(
      estimateWorkoutCalories({ ...base, avgHr: 150, weightKg: 75, age: null, sex: 'male' }),
    ).toEqual({ calories: 366, source: 'met-estimate' });
    expect(
      estimateWorkoutCalories({ ...base, avgHr: null, weightKg: 75, age: 36, sex: 'male' }),
    ).toEqual({ calories: 366, source: 'met-estimate' });
  });

  it('matches the MET value of each built-in type', () => {
    const yoga = estimateWorkoutCalories({ ...base, workoutType: 'yoga', durationMin: 60, weightKg: 75 });
    expect(yoga).toEqual({ calories: Math.round(((MET_BY_TYPE.yoga! * 3.5 * 75) / 200) * 60), source: 'met-estimate' });
    expect(MET_BY_TYPE.other).toBeGreaterThan(0);
    // case/whitespace insensitive lookup
    expect(estimateWorkoutCalories({ ...base, workoutType: ' Running ', weightKg: 75 })).toEqual({
      calories: 366,
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
    expect(low).toEqual({ calories: 366, source: 'met-estimate' });
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

describe('jump rope and stair climber', () => {
  // 11.8 MET (compendium 15551, rope jumping, moderate pace, 100-120 skips/min)
  it('estimates jump rope from the moderate-pace compendium row', () => {
    expect(estimateWorkoutCalories({ ...base, workoutType: 'jump_rope', durationMin: 10, weightKg: 75 })).toEqual({
      calories: 155,
      source: 'met-estimate',
    });
    expect(estimateWorkoutCalories({ ...base, workoutType: 'jump_rope', durationMin: 30, weightKg: 75 })).toEqual({
      calories: 465,
      source: 'met-estimate',
    });
  });

  // 9.3 MET (compendium 02065, stair treadmill ergometer, general)
  it('estimates the stair climber from the stair-treadmill compendium row', () => {
    expect(estimateWorkoutCalories({ ...base, workoutType: 'stairmaster', durationMin: 20, weightKg: 75 })).toEqual({
      calories: 244,
      source: 'met-estimate',
    });
  });

  it('burns more per minute on a rope than on stairs at the same weight', () => {
    const rope = estimateWorkoutCalories({ ...base, workoutType: 'jump_rope', durationMin: 20, weightKg: 75 });
    const stairs = estimateWorkoutCalories({ ...base, workoutType: 'stairmaster', durationMin: 20, weightKg: 75 });
    expect(rope.calories).toBeGreaterThan(stairs.calories);
  });

  it('still prefers a manual value and an HR estimate over the MET rows', () => {
    expect(
      estimateWorkoutCalories({ ...base, workoutType: 'jump_rope', durationMin: 10, weightKg: 75, manualCalories: 90 }),
    ).toEqual({ calories: 90, source: 'manual' });
    expect(
      estimateWorkoutCalories({
        ...base,
        workoutType: 'stairmaster',
        durationMin: 30,
        weightKg: 75,
        avgHr: 150,
        age: 36,
        sex: 'male',
      }),
    ).toEqual({ calories: 442, source: 'hr-estimate' });
  });
});

describe('MET_BY_TYPE', () => {
  /**
   * Every value is the "general" row of the 2024 Adult Compendium for that
   * activity (code in parentheses). Pinned here so a mistyped MET value — the
   * failure mode that silently inflates or deflates every burn estimate —
   * cannot land unnoticed.
   */
  const compendium: Array<[string, number, string]> = [
    ['running', 9.3, '12050 running, 6-6.3 mph'],
    ['cycling', 7.0, '01014 bicycling, general'],
    ['swimming', 6.0, '18310 swimming, leisurely, general'],
    ['walking', 3.8, '17190 walking, 2.8-3.4 mph, level, moderate'],
    ['strength', 6.0, '02050 resistance training, vigorous'],
    ['yoga', 2.3, '02175 yoga, general'],
    ['rowing', 7.3, '02070 rowing ergometer, general, vigorous'],
    ['hiking', 6.0, '17080 hiking, cross country'],
    ['dancing', 5.5, '03030 ballroom dancing, fast'],
    ['jump_rope', 11.8, '15551 rope jumping, moderate pace'],
    ['stairmaster', 9.3, '02065 stair treadmill ergometer, general'],
    ['other', 5.0, 'deliberate fallback, moderate band midpoint'],
  ];

  it('matches the compendium values, with no extra or missing types', () => {
    for (const [type, met, source] of compendium) {
      expect(MET_BY_TYPE[type], `${type} (${source})`).toBe(met);
    }
    expect(Object.keys(MET_BY_TYPE).sort()).toEqual(compendium.map(([type]) => type).sort());
  });

  it('keeps every MET value in a physiologically plausible band', () => {
    for (const [type, met] of Object.entries(MET_BY_TYPE)) {
      expect(met, type).toBeGreaterThan(1);
      expect(met, type).toBeLessThan(20);
    }
    // vigorous activities must outrank sedentary-ish ones
    expect(MET_BY_TYPE.jump_rope!).toBeGreaterThan(MET_BY_TYPE.walking!);
    expect(MET_BY_TYPE.stairmaster!).toBeGreaterThan(MET_BY_TYPE.walking!);
  });

  it('labels every built-in type and humanizes synced free-form types', () => {
    for (const type of Object.keys(MET_BY_TYPE)) {
      expect(WORKOUT_TYPE_LABELS[type], type).toBeTruthy();
    }
    expect(workoutTypeLabel('jump_rope')).toBe('Jump rope');
    expect(workoutTypeLabel('stairmaster')).toBe('Stairmaster');
    expect(workoutTypeLabel('kayak_polo')).toBe('Kayak polo');
  });
});
