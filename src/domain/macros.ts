/**
 * Deterministic macro (protein / carbohydrate / fat) calculation.
 * Mirrors the calorie formula: grams/100g ÷ 100 × amount × servingGrams,
 * with each result rounded to one decimal gram. Model output NEVER enters
 * this function — nutrient values come only from the USDA-backed catalog.
 */
import { roundTo } from './calories';

function assertNutrient(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} per 100 g must be a finite, non-negative number (got ${value})`);
  }
}

function assertAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError(`amount must be a finite, non-negative number (got ${amount})`);
  }
}

function assertServingGrams(servingGrams: number): void {
  if (!Number.isFinite(servingGrams) || servingGrams <= 0) {
    throw new RangeError(`serving grams must be finite and positive (got ${servingGrams})`);
  }
}

/**
 * Grams of protein/carbs/fat for `amount` servings, each rounded to 1 decimal.
 * Formula per macro: g/100g ÷ 100 × amount × servingGrams.
 * Rejects non-finite/negative nutrients, non-positive serving grams, and
 * non-finite/negative amounts.
 */
export function calculateMacros(
  proteinPer100g: number,
  carbsPer100g: number,
  fatPer100g: number,
  amount: number,
  servingGrams: number,
): { proteinGrams: number; carbsGrams: number; fatGrams: number } {
  assertNutrient(proteinPer100g, 'Protein');
  assertNutrient(carbsPer100g, 'Carbohydrate');
  assertNutrient(fatPer100g, 'Fat');
  assertAmount(amount);
  assertServingGrams(servingGrams);
  const factor = (amount * servingGrams) / 100;
  return {
    proteinGrams: roundTo(proteinPer100g * factor, 1),
    carbsGrams: roundTo(carbsPer100g * factor, 1),
    fatGrams: roundTo(fatPer100g * factor, 1),
  };
}
