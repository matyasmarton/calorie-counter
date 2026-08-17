/**
 * aggregateFoodInput / buildRecipeInput / draftGrams tests: deterministic
 * per-100 g aggregation for localized dishes. The app — never a model —
 * computes these values from catalog matches.
 */
import { aggregateFoodInput, buildRecipeInput, draftGrams } from '@/local-ai/draftToFood';
import type { DraftEntryProposal } from '@/local-ai/draftToEntries';
import type { Food, Serving } from '@/domain/types';
import { describe, expect, it } from 'vitest';

function makeFood(overrides: Partial<Food> & { id: string; name: string }): Food {
  return {
    category: 'Test',
    caloriesPer100g: 100,
    proteinPer100g: 10,
    carbsPer100g: 10,
    fatPer100g: 5,
    servings: [
      { id: 'cup', label: 'cup', grams: 245, approx: false },
      { id: 'tbsp', label: 'tbsp', grams: 21, approx: true },
    ],
    source: 'catalog',
    ownerId: null,
    sourceRef: 'USDA test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

const YOGURT = makeFood({ id: 'f-yogurt', name: 'Yogurt, Greek, plain, nonfat', caloriesPer100g: 59, proteinPer100g: 10.2, carbsPer100g: 3.6, fatPer100g: 0.4 });
const HONEY = makeFood({ id: 'f-honey', name: 'Honey', caloriesPer100g: 304, proteinPer100g: 0.3, carbsPer100g: 82.4, fatPer100g: 0 });
const LEGACY = makeFood({ id: 'f-legacy', name: 'Legacy food', caloriesPer100g: 100, proteinPer100g: null, carbsPer100g: null, fatPer100g: null });

function RICE(): Food {
  return makeFood({ id: 'f-rice', name: 'Rice, white, cooked', caloriesPer100g: 130 });
}

function proposal(food: Food | null, amount: number, servingId: string | null, raw = food?.name ?? 'x'): DraftEntryProposal {
  return {
    ingredient: { raw, foodQuery: food?.name ?? null, amount, servingLabel: null },
    food,
    servingId,
    amount,
  };
}

describe('aggregateFoodInput', () => {
  it('computes deterministic per-100 g values from two matched ingredients', () => {
    const input = aggregateFoodInput('yogurt & honey', [
      proposal(YOGURT, 1, 'cup'),
      proposal(HONEY, 1, 'tbsp'),
    ]);
    expect(input).not.toBeNull();
    expect(input!.name).toBe('yogurt & honey');
    expect(input!.category).toBe('Recipes');
    // totals: 245 g yogurt (145 kcal) + 21 g honey (64 kcal) = 266 g, 209 kcal
    expect(input!.caloriesPer100g).toBe(79); // round(209/266*100)
    expect(input!.proteinPer100g).toBe(9.4);
    expect(input!.carbsPer100g).toBe(9.8);
    expect(input!.fatPer100g).toBe(0.4);
    // serving list: 100 g base + one serving per ingredient
    expect(input!.servings).toHaveLength(3);
    expect(input!.servings[0]).toEqual({ id: '100g', label: '100 g', grams: 100, approx: false });
    expect(input!.servings[1]).toMatchObject({ id: 'f-yogurt:cup', label: 'Yogurt, Greek, plain, nonfat · cup', grams: 245, approx: false });
    expect(input!.servings[2]).toMatchObject({ id: 'f-honey:tbsp', label: 'Honey · tbsp', grams: 21, approx: true });
  });

  it('returns null when nothing is matchable', () => {
    expect(aggregateFoodInput('mystery', [proposal(null, 1, null)])).toBeNull();
    expect(aggregateFoodInput('mystery', [])).toBeNull();
  });

  it('excludes unmatched ingredients instead of guessing', () => {
    const input = aggregateFoodInput('rice + unknown', [proposal(RICE(), 1, 'cup'), proposal(null, 1, null)]);
    expect(input).not.toBeNull();
    expect(input!.servings).toHaveLength(2); // base + rice only
  });

  it('keeps macros null when any included ingredient lacks macro data', () => {
    const input = aggregateFoodInput('legacy mix', [proposal(LEGACY, 1, 'cup'), proposal(YOGURT, 1, 'cup')]);
    expect(input).not.toBeNull();
    expect(input!.proteinPer100g).toBeNull();
    expect(input!.carbsPer100g).toBeNull();
    expect(input!.fatPer100g).toBeNull();
    expect(input!.caloriesPer100g).toBeGreaterThan(0);
  });

  it('handles single-ingredient dishes', () => {
    const input = aggregateFoodInput('just yogurt', [proposal(YOGURT, 1, 'cup')]);
    expect(input!.caloriesPer100g).toBe(59); // same as the source food
    expect(input!.proteinPer100g).toBe(10.2);
  });
});

describe('buildRecipeInput', () => {
  it('builds parallel ingredient/foodId arrays with total serving grams', () => {
    const input = buildRecipeInput('lecsó', [
      proposal(YOGURT, 1, 'cup'),
      proposal(HONEY, 1, 'tbsp'),
      proposal(null, 1, null),
    ], ['lecsó', ' lecso ']);
    expect(input).not.toBeNull();
    expect(input!.name).toBe('lecsó');
    expect(input!.ingredients).toHaveLength(2);
    expect(input!.foodIds).toEqual(['f-yogurt', 'f-honey']);
    expect(input!.servingGrams).toBe(266);
    expect(input!.aliases).toEqual(['lecsó', 'lecso']);
  });

  it('returns null when no ingredient is resolved', () => {
    expect(buildRecipeInput('lecsó', [proposal(null, 1, null)])).toBeNull();
  });
});

describe('draftGrams', () => {
  it('sums the matched portion of a draft', () => {
    expect(draftGrams([proposal(YOGURT, 1, 'cup'), proposal(HONEY, 1, 'tbsp'), proposal(null, 1, null)])).toBe(266);
    expect(draftGrams([proposal(null, 1, null)])).toBe(0);
  });
});
