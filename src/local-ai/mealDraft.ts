/**
 * Schema-only validation of structured model output. The app never trusts
 * a model's arithmetic or nutrient claims — this module only checks shape
 * and marks drafts that need human review. Nutrient values come exclusively
 * from the USDA-backed catalog via deterministic calculation.
 */
import type { MealDraft, MealIngredient } from './types';

export class MealDraftValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MealDraftValidationError';
  }
}

function isFiniteOrNull(v: unknown): boolean {
  return v == null || (typeof v === 'number' && Number.isFinite(v));
}

function isStringOrNull(v: unknown): boolean {
  return v == null || typeof v === 'string';
}

/** Validate one ingredient shape; returns null when valid, else a reason. */
export function validateIngredient(raw: unknown): MealIngredient | string {
  if (!raw || typeof raw !== 'object') return 'ingredient must be an object';
  const r = raw as Record<string, unknown>;
  if (typeof r.raw !== 'string' || r.raw.trim() === '') return 'ingredient.raw must be a non-empty string';
  if (!isStringOrNull(r.foodQuery)) return 'ingredient.foodQuery must be a string or null';
  if (!isFiniteOrNull(r.amount)) return 'ingredient.amount must be a number or null';
  if (r.amount != null && (r.amount as number) < 0) return 'ingredient.amount must be non-negative';
  if (!isStringOrNull(r.servingLabel)) return 'ingredient.servingLabel must be a string or null';
  return {
    raw: r.raw as string,
    foodQuery: (r.foodQuery as string | null) ?? null,
    amount: (r.amount as number | null) ?? null,
    servingLabel: (r.servingLabel as string | null) ?? null,
  };
}

/**
 * Validate raw model output into a MealDraft. Throws on malformed shape;
 * returns a draft flagged `needsReview` when data is missing or confidence
 * is below 0.8. This is the ONLY gateway between a model and the app.
 */
export function parseMealDraft(raw: unknown): MealDraft {
  if (!raw || typeof raw !== 'object') {
    throw new MealDraftValidationError('Meal draft must be an object');
  }
  const d = raw as Record<string, unknown>;
  if (typeof d.mealDescription !== 'string' || d.mealDescription.trim() === '') {
    throw new MealDraftValidationError('Meal draft needs a non-empty mealDescription');
  }
  if (!Array.isArray(d.ingredients) || d.ingredients.length === 0) {
    throw new MealDraftValidationError('Meal draft needs at least one ingredient');
  }
  const confidence = Number(d.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new MealDraftValidationError('Meal draft confidence must be a number in [0, 1]');
  }

  const ingredients: MealIngredient[] = [];
  for (const rawIng of d.ingredients) {
    const parsed = validateIngredient(rawIng);
    if (typeof parsed === 'string') throw new MealDraftValidationError(parsed);
    ingredients.push(parsed);
  }

  const incomplete = ingredients.some(
    (i) =>
      i.amount == null ||
      i.servingLabel == null ||
      i.foodQuery == null ||
      i.foodQuery.trim() === '',
  );
  return {
    mealDescription: d.mealDescription as string,
    ingredients,
    confidence,
    needsReview: incomplete || confidence < 0.8,
  };
}
