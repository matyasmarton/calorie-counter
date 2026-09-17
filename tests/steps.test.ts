/**
 * Steps → burn: the stride ratio, the ACSM-derived net energy cost, and the
 * input the equation refuses.
 */
import { ValidationError } from '@/domain/errors';
import { estimateStepsCalories, stepLengthM } from '@/domain/steps';
import { describe, expect, it } from 'vitest';

/** A 180 cm, 75 kg walker: 0.747 m stride, so 10 000 steps is 7.47 km. */
const WALKER = { weightKg: 75, heightCm: 180 };

describe('stepLengthM', () => {
  it('is the pedometer ratio of height, by sex', () => {
    expect(stepLengthM(180, 'male')).toBeCloseTo(0.747, 6);
    expect(stepLengthM(180, 'female')).toBeCloseTo(0.7434, 6);
    expect(stepLengthM(180, null)).toBeCloseTo(0.7452, 6);
  });

  it('rejects a height it cannot use', () => {
    expect(() => stepLengthM(0, 'male')).toThrow(ValidationError);
    expect(() => stepLengthM(-10, 'male')).toThrow(ValidationError);
    expect(() => stepLengthM(Number.NaN, 'male')).toThrow(ValidationError);
  });
});

describe('estimateStepsCalories', () => {
  it('costs 0.5 kcal per kg per km of level walking', () => {
    // 10 000 × 0.747 m = 7.47 km; 7.47 × 75 × 0.5 = 280.1 → 280
    expect(estimateStepsCalories({ steps: 10000, sex: 'male', ...WALKER })).toBe(280);
    // Halving the distance halves the burn.
    expect(estimateStepsCalories({ steps: 5000, sex: 'male', ...WALKER })).toBe(140);
    // Heavier walkers spend more for the same distance: 7.47 × 90 × 0.5 = 336.2
    expect(estimateStepsCalories({ steps: 10000, sex: 'male', weightKg: 90, heightCm: 180 })).toBe(
      336,
    );
  });

  it('walks a shorter distance per step for women, and in between without a sex', () => {
    const male = estimateStepsCalories({ steps: 20000, sex: 'male', ...WALKER });
    const neutral = estimateStepsCalories({ steps: 20000, sex: null, ...WALKER });
    const female = estimateStepsCalories({ steps: 20000, sex: 'female', ...WALKER });
    expect(male).toBe(560);
    expect(neutral).toBe(559);
    expect(female).toBe(558);
    expect(male).toBeGreaterThan(neutral);
    expect(neutral).toBeGreaterThan(female);
  });

  it('is zero for a day with no steps', () => {
    expect(estimateStepsCalories({ steps: 0, sex: 'male', ...WALKER })).toBe(0);
  });

  it('rejects steps or a weight the equation cannot use', () => {
    expect(() => estimateStepsCalories({ steps: -1, sex: 'male', ...WALKER })).toThrow(ValidationError);
    expect(() => estimateStepsCalories({ steps: 1.5, sex: 'male', ...WALKER })).toThrow(ValidationError);
    expect(() => estimateStepsCalories({ steps: Number.NaN, sex: 'male', ...WALKER })).toThrow(
      ValidationError,
    );
    expect(() =>
      estimateStepsCalories({ steps: 100, sex: 'male', weightKg: 0, heightCm: 180 }),
    ).toThrow(ValidationError);
    expect(() =>
      estimateStepsCalories({ steps: 100, sex: 'male', weightKg: 75, heightCm: -1 }),
    ).toThrow(ValidationError);
  });
});
