import type { Serving } from './types';

/** Round a number to `dp` decimal places (string-safe, avoids float drift for display). */
export function roundTo(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON) * f) / f;
}

function assertAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError(`amount must be a finite, non-negative number (got ${amount})`);
  }
}

/**
 * Convert a serving count to grams: amount × serving.grams.
 * Rejects non-finite or negative amounts. Grams rounded to 1 decimal.
 */
export function servingAmountToGrams(serving: Serving, amount: number): number {
  assertAmount(amount);
  if (!Number.isFinite(serving.grams) || serving.grams <= 0) {
    throw new RangeError(`serving grams must be finite and positive (got ${serving.grams})`);
  }
  return roundTo(amount * serving.grams, 1);
}

/**
 * Calories for `amount` servings of a food at `caloriesPer100g` kcal/100g.
 * Formula: kcal/100g ÷ 100 × amount × servingGrams. Rounds to a whole calorie.
 * Rejects non-finite calories, non-positive serving grams, and invalid amounts.
 */
export function calculateCalories(
  foodCaloriesPer100g: number,
  amount: number,
  servingGrams: number,
): number {
  assertAmount(amount);
  if (!Number.isFinite(foodCaloriesPer100g) || foodCaloriesPer100g < 0) {
    throw new RangeError(`calories per 100 g must be finite and non-negative (got ${foodCaloriesPer100g})`);
  }
  if (!Number.isFinite(servingGrams) || servingGrams <= 0) {
    throw new RangeError(`serving grams must be finite and positive (got ${servingGrams})`);
  }
  return Math.round((foodCaloriesPer100g / 100) * amount * servingGrams);
}
