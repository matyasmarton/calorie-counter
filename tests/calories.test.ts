import { calculateCalories, servingAmountToGrams } from '@/domain/calories';
import type { Serving } from '@/domain/types';
import { describe, expect, it } from 'vitest';

const cup: Serving = { id: 'cup', label: 'cup', grams: 240, approx: false };
const tbsp: Serving = { id: 'tbsp', label: 'tbsp', grams: 15, approx: false };
const handful: Serving = { id: 'handful', label: 'handful', grams: 30, approx: true };

describe('servingAmountToGrams', () => {
  it('converts household measures to grams', () => {
    expect(servingAmountToGrams(cup, 1)).toBe(240);
    expect(servingAmountToGrams(cup, 0.5)).toBe(120);
    expect(servingAmountToGrams(tbsp, 2)).toBe(30);
    expect(servingAmountToGrams(handful, 2)).toBe(60);
  });

  it('rounds grams to one decimal', () => {
    expect(servingAmountToGrams({ id: 'x', label: 'x', grams: 28.35, approx: false }, 3)).toBe(85.1);
  });

  it('allows zero amount (zero grams)', () => {
    expect(servingAmountToGrams(cup, 0)).toBe(0);
  });

  it('rejects non-finite or negative amounts', () => {
    expect(() => servingAmountToGrams(cup, -1)).toThrow(RangeError);
    expect(() => servingAmountToGrams(cup, NaN)).toThrow(RangeError);
    expect(() => servingAmountToGrams(cup, Infinity)).toThrow(RangeError);
  });

  it('rejects invalid serving grams', () => {
    expect(() => servingAmountToGrams({ id: 'x', label: 'x', grams: 0, approx: false }, 1)).toThrow(RangeError);
    expect(() => servingAmountToGrams({ id: 'x', label: 'x', grams: -5, approx: false }, 1)).toThrow(RangeError);
  });
});

describe('calculateCalories', () => {
  it('computes calories from kcal/100g and grams', () => {
    // 100 kcal/100 g × 240 g = 240 kcal
    expect(calculateCalories(100, 1, 240)).toBe(240);
    // 32 kcal/100 g × 76 g = 24.32 → 24
    expect(calculateCalories(32, 1, 76)).toBe(24);
  });

  it('scales by amount', () => {
    expect(calculateCalories(50, 2, 100)).toBe(100);
  });

  it('rounds to the nearest whole calorie', () => {
    expect(calculateCalories(33, 1, 100)).toBe(33); // 33.0
    expect(calculateCalories(33.5, 1, 100)).toBe(34); // 33.5 → 34
    expect(calculateCalories(20, 1, 5)).toBe(1); // 1.0
  });

  it('handles zero-calorie foods', () => {
    expect(calculateCalories(0, 2, 240)).toBe(0);
  });

  it('rejects invalid inputs', () => {
    expect(() => calculateCalories(-1, 1, 100)).toThrow(RangeError);
    expect(() => calculateCalories(NaN, 1, 100)).toThrow(RangeError);
    expect(() => calculateCalories(100, -1, 100)).toThrow(RangeError);
    expect(() => calculateCalories(100, Infinity, 100)).toThrow(RangeError);
    expect(() => calculateCalories(100, 1, 0)).toThrow(RangeError);
    expect(() => calculateCalories(100, 1, -10)).toThrow(RangeError);
  });
});
