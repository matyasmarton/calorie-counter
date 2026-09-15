import { calculateMacros } from '@/domain/macros';
import { describe, expect, it } from 'vitest';

describe('calculateMacros', () => {
  it('computes grams from per-100g values and serving grams', () => {
    // Greek yogurt: 10g protein / 4g carbs / 0.4g fat per 100g, 1 cup = 240g
    const m = calculateMacros(10, 4, 0.4, 1, 240);
    expect(m.proteinGrams).toBe(24);
    expect(m.carbsGrams).toBe(9.6);
    expect(m.fatGrams).toBe(1);
  });

  it('scales by amount', () => {
    const m = calculateMacros(20, 5, 10, 2, 100); // 2 × 100g = 200g
    expect(m.proteinGrams).toBe(40);
    expect(m.carbsGrams).toBe(10);
    expect(m.fatGrams).toBe(20);
  });

  it('rounds each macro to one decimal', () => {
    // 33.33g protein / 100g × 0.5 × 240g = 39.996 → 40.0
    const m = calculateMacros(33.33, 0, 0, 0.5, 240);
    expect(m.proteinGrams).toBe(40);
    // 12.345 → 12.3
    expect(calculateMacros(12.345, 0, 0, 1, 100).proteinGrams).toBe(12.3);
  });

  it('handles zero-valued nutrients', () => {
    const m = calculateMacros(0, 0, 0, 2, 240);
    expect(m).toEqual({ proteinGrams: 0, carbsGrams: 0, fatGrams: 0 });
  });

  it('rejects negative or non-finite nutrient inputs', () => {
    expect(() => calculateMacros(-1, 0, 0, 1, 100)).toThrow(RangeError);
    expect(() => calculateMacros(NaN, 0, 0, 1, 100)).toThrow(RangeError);
    expect(() => calculateMacros(0, Infinity, 0, 1, 100)).toThrow(RangeError);
    expect(() => calculateMacros(0, 0, -0.1, 1, 100)).toThrow(RangeError);
  });

  it('rejects invalid serving grams', () => {
    expect(() => calculateMacros(10, 5, 2, 1, 0)).toThrow(RangeError);
    expect(() => calculateMacros(10, 5, 2, 1, -240)).toThrow(RangeError);
    expect(() => calculateMacros(10, 5, 2, 1, NaN)).toThrow(RangeError);
  });

  it('rejects invalid amounts', () => {
    expect(() => calculateMacros(10, 5, 2, -1, 240)).toThrow(RangeError);
    expect(() => calculateMacros(10, 5, 2, Infinity, 240)).toThrow(RangeError);
    expect(() => calculateMacros(10, 5, 2, NaN, 240)).toThrow(RangeError);
  });
});
