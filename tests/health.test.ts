import { bmiResult, calculateBmi, classifyBmi, type BmiCategory } from '@/domain/health';
import { describe, expect, it } from 'vitest';

describe('calculateBmi', () => {
  it('computes weight / height^2 rounded to one decimal', () => {
    // 70 / 1.75² = 22.857… → 22.9
    expect(calculateBmi(70, 175)).toBe(22.9);
    // 50 / 2² = 12.5
    expect(calculateBmi(50, 200)).toBe(12.5);
    // 100 / 2² = 25.0 (rounding keeps the decimal)
    expect(calculateBmi(100, 200)).toBe(25);
  });

  it('rejects non-finite or non-positive inputs', () => {
    expect(() => calculateBmi(0, 175)).toThrow(RangeError);
    expect(() => calculateBmi(-70, 175)).toThrow(RangeError);
    expect(() => calculateBmi(NaN, 175)).toThrow(RangeError);
    expect(() => calculateBmi(Infinity, 175)).toThrow(RangeError);
    expect(() => calculateBmi(70, 0)).toThrow(RangeError);
    expect(() => calculateBmi(70, -175)).toThrow(RangeError);
    expect(() => calculateBmi(70, NaN)).toThrow(RangeError);
  });
});

describe('classifyBmi', () => {
  const cases: [number, BmiCategory][] = [
    [10, 'underweight'],
    [18.4, 'underweight'],
    [18.5, 'healthy'],
    [24.9, 'healthy'],
    [25, 'overweight'],
    [29.9, 'overweight'],
    [30, 'obesity'],
    [40, 'obesity'],
  ];
  for (const [bmi, category] of cases) {
    it(`classifies ${bmi} as ${category}`, () => {
      expect(classifyBmi(bmi)).toBe(category);
    });
  }

  it('rejects non-finite BMI', () => {
    expect(() => classifyBmi(NaN)).toThrow(RangeError);
    expect(() => classifyBmi(Infinity)).toThrow(RangeError);
  });
});

describe('bmiResult', () => {
  it('combines calculation and classification', () => {
    expect(bmiResult(70, 175)).toEqual({ bmi: 22.9, category: 'healthy' });
    expect(bmiResult(50, 150)).toEqual({ bmi: 22.2, category: 'healthy' });
  });
});
