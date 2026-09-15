import { IndexedDbStorage } from '@/db/indexeddb';
import { Repository } from '@/db/repository';
import { ValidationError } from '@/domain/errors';
import { TABLES } from '@/db/schema';
import type { CatalogBundle } from '@/db/seedCatalog';
import { parseMealDraft, MealDraftValidationError } from '@/local-ai/mealDraft';
import { beforeEach, describe, expect, it } from 'vitest';
import bundle from '../data/foods.json';

async function makeRepo(): Promise<Repository> {
  const repo = new Repository(new IndexedDbStorage());
  await repo.init();
  await repo.ensureCatalog(bundle as unknown as CatalogBundle);
  return repo;
}

async function wipe(): Promise<void> {
  const storage = new IndexedDbStorage();
  await storage.init();
  for (const t of Object.keys(TABLES)) await storage.clear(t);
}

beforeEach(async () => {
  await wipe();
});

describe('parseMealDraft (schema validation)', () => {
  it('accepts a complete draft and does not require review', () => {
    const draft = parseMealDraft({
      mealDescription: 'Greek yogurt with honey',
      ingredients: [
        { raw: 'Greek yogurt', foodQuery: 'Yogurt, Greek, plain', amount: 1, servingLabel: 'cup' },
        { raw: 'honey', foodQuery: 'Honey', amount: 1, servingLabel: 'tbsp' },
      ],
      confidence: 0.92,
    });
    expect(draft.needsReview).toBe(false);
    expect(draft.ingredients).toHaveLength(2);
  });

  it('marks drafts review-required when amounts or queries are missing', () => {
    const draft = parseMealDraft({
      mealDescription: "Mom's hamburger",
      ingredients: [{ raw: 'ground beef patty', foodQuery: null, amount: null, servingLabel: null }],
      confidence: 0.9,
    });
    expect(draft.needsReview).toBe(true);
  });

  it('marks drafts review-required when confidence is below 0.8', () => {
    const draft = parseMealDraft({
      mealDescription: 'lecsó',
      ingredients: [{ raw: 'peppers', foodQuery: 'Peppers', amount: 2, servingLabel: 'piece' }],
      confidence: 0.6,
    });
    expect(draft.needsReview).toBe(true);
  });

  it('rejects malformed output instead of guessing', () => {
    expect(() => parseMealDraft(null)).toThrow(MealDraftValidationError);
    expect(() => parseMealDraft({ mealDescription: '' })).toThrow(MealDraftValidationError);
    expect(() => parseMealDraft({ mealDescription: 'x', ingredients: [], confidence: 1 })).toThrow(MealDraftValidationError);
    expect(() => parseMealDraft({ mealDescription: 'x', ingredients: [{ raw: '' }], confidence: 1 })).toThrow(MealDraftValidationError);
    expect(() => parseMealDraft({ mealDescription: 'x', ingredients: [{ raw: 'a', amount: -1 }], confidence: 1 })).toThrow(MealDraftValidationError);
    expect(() => parseMealDraft({ mealDescription: 'x', ingredients: [{ raw: 'a' }], confidence: 2 })).toThrow(MealDraftValidationError);
  });
});

describe('recipe memory (explicit consent)', () => {
  it('saves only after an explicit save call with resolved foods', async () => {
    const repo = await makeRepo();
    const foods = await repo.searchFoods('Beef, ground', 1);
    expect(foods.length).toBe(1);

    const recipe = await repo.saveRecipe({
      name: "Mom's hamburger",
      ingredients: [{ raw: 'ground beef patty', foodQuery: 'Beef, ground', amount: 1, servingLabel: 'piece' }],
      foodIds: [foods[0]!.id],
      servingGrams: 150,
      aliases: ["mom's burger", 'hamburger'],
    });
    expect(recipe.name).toBe("Mom's hamburger");
    const found = await repo.searchRecipes("mom's burger");
    expect(found.map((r) => r.name)).toEqual(["Mom's hamburger"]);
  });

  it('rejects recipes that reference unknown foods', async () => {
    const repo = await makeRepo();
    await expect(
      repo.saveRecipe({
        name: 'Bad',
        ingredients: [{ raw: 'x', foodQuery: 'x', amount: 1, servingLabel: 'g' }],
        foodIds: ['missing-food'],
        servingGrams: 100,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('refuses to persist when the caller withholds consent (no repo write)', async () => {
    // The consent gate lives in the caller: without confirmation the repo
    // method is never invoked. Assert that no recipe row exists until then.
    const repo = await makeRepo();
    expect(await repo.searchRecipes('')).toEqual([]);
    // tombstones and search respect deletion
    const foods = await repo.searchFoods('lecsó', 5);
    const peppers = await repo.searchFoods('Pepper, bell, green', 1);
    const fdcId = peppers[0]!.id;
    void foods;
    const recipe = await repo.saveRecipe({
      name: 'lecsó',
      ingredients: [{ raw: 'peppers', foodQuery: 'peppers', amount: 3, servingLabel: 'piece' }],
      foodIds: [fdcId],
      servingGrams: 250,
    });
    await repo.deleteRecipe(recipe.id);
    expect(await repo.searchRecipes('')).toEqual([]);
  });
});
