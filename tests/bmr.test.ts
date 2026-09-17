/**
 * Basal metabolic rate: the Mifflin-St Jeor equation, and the constants it uses
 * when the profile does not disclose a sex.
 */
import { basalMetabolicRate } from '@/domain/bmr';
import { ValidationError } from '@/domain/errors';
import { describe, expect, it } from 'vitest';

/** 10 × kg + 6.25 × cm − 5 × age + constant. */
function mifflin(weightKg: number, heightCm: number, age: number, constant: number): number {
  return Math.round(10 * weightKg + 6.25 * heightCm - 5 * age + constant);
}

describe('basalMetabolicRate', () => {
  it('applies the Mifflin-St Jeor equation for a known sex', () => {
    // 10×80 + 6.25×180 − 5×30 = 1775, plus the sex constant.
    expect(basalMetabolicRate({ weightKg: 80, heightCm: 180, age: 30, sex: 'male' })).toBe(
      mifflin(80, 180, 30, 5),
    );
    expect(basalMetabolicRate({ weightKg: 80, heightCm: 180, age: 30, sex: 'female' })).toBe(
      mifflin(80, 180, 30, -161),
    );
    expect(mifflin(80, 180, 30, 5)).toBe(1780);
    expect(mifflin(80, 180, 30, -161)).toBe(1614);
  });

  it('falls back to the mean of the two constants when sex is not disclosed', () => {
    const neutral = basalMetabolicRate({ weightKg: 80, heightCm: 180, age: 30, sex: null });
    const male = basalMetabolicRate({ weightKg: 80, heightCm: 180, age: 30, sex: 'male' });
    const female = basalMetabolicRate({ weightKg: 80, heightCm: 180, age: 30, sex: 'female' });
    // The mean constant sits between the two, and keeps the estimate unbiased.
    expect(neutral).toBe(1697);
    expect(neutral).toBeLessThan(male);
    expect(neutral).toBeGreaterThan(female);
  });

  it('rises with weight and height and falls with age', () => {
    const base = basalMetabolicRate({ weightKg: 70, heightCm: 175, age: 40, sex: 'male' });
    expect(basalMetabolicRate({ weightKg: 71, heightCm: 175, age: 40, sex: 'male' })).toBe(base + 10);
    expect(basalMetabolicRate({ weightKg: 70, heightCm: 179, age: 40, sex: 'male' })).toBe(base + 25);
    expect(basalMetabolicRate({ weightKg: 70, heightCm: 175, age: 41, sex: 'male' })).toBe(base - 5);
  });

  it('rounds to whole kcal', () => {
    // 754 + 1116.25 − 205 + 5 = 1670.25
    expect(basalMetabolicRate({ weightKg: 75.4, heightCm: 178.6, age: 41, sex: 'male' })).toBe(1670);
    // 748 + 1100 − 100 + 5 = 1753 exactly
    expect(basalMetabolicRate({ weightKg: 74.8, heightCm: 176, age: 20, sex: 'male' })).toBe(1753);
  });

  it('accepts an infant age but rejects an impossible one', () => {
    expect(basalMetabolicRate({ weightKg: 10, heightCm: 75, age: 0, sex: null })).toBeGreaterThan(0);
    expect(() => basalMetabolicRate({ weightKg: 70, heightCm: 175, age: 130, sex: null })).not.toThrow();
    expect(() => basalMetabolicRate({ weightKg: 70, heightCm: 175, age: 131, sex: null })).toThrow(
      ValidationError,
    );
    expect(() => basalMetabolicRate({ weightKg: 70, heightCm: 175, age: -1, sex: null })).toThrow(
      ValidationError,
    );
    expect(() => basalMetabolicRate({ weightKg: 70, heightCm: 175, age: 30.5, sex: null })).toThrow(
      ValidationError,
    );
  });

  it('rejects a weight or height the equation cannot use', () => {
    expect(() => basalMetabolicRate({ weightKg: 0, heightCm: 175, age: 30, sex: null })).toThrow(
      ValidationError,
    );
    expect(() => basalMetabolicRate({ weightKg: -5, heightCm: 175, age: 30, sex: null })).toThrow(
      ValidationError,
    );
    expect(() => basalMetabolicRate({ weightKg: 70, heightCm: 0, age: 30, sex: null })).toThrow(
      ValidationError,
    );
    expect(() =>
      basalMetabolicRate({ weightKg: 70, heightCm: Number.NaN, age: 30, sex: null }),
    ).toThrow(ValidationError);
  });
});
