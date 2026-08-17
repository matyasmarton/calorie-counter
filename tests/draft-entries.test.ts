/**
 * resolveDraft tests: deterministic ingredient → catalog-food mapping.
 * The model never picks foods; this module does, top-hit + serving match.
 */
import { resolveDraft } from '@/local-ai/draftToEntries';
import type { Food } from '@/domain/types';
import type { MealDraft } from '@/local-ai/types';
import { describe, expect, it } from 'vitest';

function makeFood(overrides: Partial<Food> & { id: string; name: string }): Food {
  return {
    category: 'Test',
    caloriesPer100g: 100,
    proteinPer100g: 10,
    carbsPer100g: 10,
    fatPer100g: 5,
    servings: [
      { id: 'cup', label: 'cup', grams: 240, approx: false },
      { id: 'piece', label: 'piece', grams: 100, approx: false },
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
const RICE = makeFood({ id: 'f-rice', name: 'Rice, white, cooked', caloriesPer100g: 130 });

function draft(ingredients: MealDraft['ingredients']): MealDraft {
  return { mealDescription: 'test', ingredients, confidence: 0.95, needsReview: false };
}

const noHits = async () => [];

describe('resolveDraft', () => {
  it('maps an ingredient to the top search hit with a case-insensitive serving match', async () => {
    const search = async (q: string) => (q === 'greek yogurt' ? [YOGURT] : []);
    const props = await resolveDraft(
      draft([{ raw: 'greek yogurt', foodQuery: 'greek yogurt', amount: 1, servingLabel: 'CUP' }]),
      search,
    );
    const p = props[0]!;
    expect(p.food?.id).toBe('f-yogurt');
    expect(p.servingId).toBe('cup');
    expect(p.amount).toBe(1);
  });

  it('falls back to the first serving when the label does not match', async () => {
    const search = async () => [RICE];
    const props = await resolveDraft(
      draft([{ raw: 'rice', foodQuery: 'rice', amount: 2, servingLabel: 'bowl' }]),
      search,
    );
    const p = props[0]!;
    expect(p.food?.id).toBe('f-rice');
    expect(p.servingId).toBe('cup'); // first serving of RICE
    expect(p.amount).toBe(2);
  });

  it('defaults a missing amount to 1', async () => {
    const search = async () => [YOGURT];
    const props = await resolveDraft(
      draft([{ raw: 'yogurt', foodQuery: 'yogurt', amount: null, servingLabel: null }]),
      search,
    );
    const p = props[0]!;
    expect(p.amount).toBe(1);
    expect(p.servingId).toBe('cup');
  });

  it('falls back to raw word matching when the ingredient has no foodQuery', async () => {
    const search = async (q: string) => (q === 'yogurt' ? [YOGURT] : []);
    const props = await resolveDraft(
      draft([{ raw: 'greek yogurt', foodQuery: null, amount: 1, servingLabel: null }]),
      search,
    );
    const p = props[0]!;
    expect(p.food?.id).toBe('f-yogurt');
  });

  it('leaves food null when the search has no hit', async () => {
    const props = await resolveDraft(
      draft([{ raw: 'lecsó base', foodQuery: 'unknown regional dish', amount: 1, servingLabel: null }]),
      noHits,
    );
    const p = props[0]!;
    expect(p.food).toBeNull();
  });

  it('handles mixed drafts: matched + unmatched ingredients stay parallel', async () => {
    const search = async (q: string) => (q === 'rice' ? [RICE] : []);
    const props = await resolveDraft(
      draft([
        { raw: 'rice', foodQuery: 'rice', amount: 1, servingLabel: 'cup' },
        { raw: 'sausage', foodQuery: 'smoked sausage', amount: 1, servingLabel: null },
      ]),
      search,
    );
    expect(props).toHaveLength(2);
    expect(props[0]!.food?.id).toBe('f-rice');
    expect(props[1]!.food).toBeNull();
  });

  it('treats whitespace-only food queries as missing and falls back to raw', async () => {
    const search = async (q: string) => (q === 'yogurt' ? [YOGURT] : []);
    const props = await resolveDraft(
      draft([{ raw: 'greek yogurt', foodQuery: '   ', amount: 1, servingLabel: null }]),
      search,
    );
    const p = props[0]!;
    expect(p.food?.id).toBe('f-yogurt');
  });

  it('falls back to the raw ingredient name when the foodQuery has no hits', async () => {
    // catalog has the food under a reordered name: substring "greek yogurt"
    // matches nothing, but "yogurt, greek..." matches the raw term
    const search = async (q: string) => (q.toLowerCase().includes('yogurt, greek') || q === 'greek yogurt' || q === 'yogurt' ? [YOGURT] : []);
    const props = await resolveDraft(
      draft([{ raw: 'greek yogurt', foodQuery: 'greek yogurt', amount: 1, servingLabel: null }]),
      search,
    );
    const p = props[0]!;
    expect(p.food?.id).toBe('f-yogurt');
  });

  it('falls back to the longest query word when nothing else matches', async () => {
    const search = async (q: string) => (q === 'greek' ? [YOGURT] : []);
    const props = await resolveDraft(
      draft([{ raw: 'greek yogurt', foodQuery: 'greek yogurt', amount: 1, servingLabel: null }]),
      search,
    );
    const p = props[0]!;
    expect(p.food?.id).toBe('f-yogurt');
  });

  it('ignores short and non-alpha words in the fallback', async () => {
    const search = async (q: string) => (q === 'yogurt' ? [YOGURT] : []);
    const props = await resolveDraft(
      draft([{ raw: 'greek yogurt', foodQuery: 'greek yogurt', amount: 1, servingLabel: null }]),
      search,
    );
    const p = props[0]!;
    expect(p.food?.id).toBe('f-yogurt'); // 'greek' first, then 'yogurt' (>=3 chars, alpha only)
  });

  it('stays null when neither the query, raw, nor any word matches', async () => {
    const search = async () => [];
    const props = await resolveDraft(
      draft([{ raw: 'mystery', foodQuery: 'mystery dish', amount: 1, servingLabel: null }]),
      search,
    );
    const p = props[0]!;
    expect(p.food).toBeNull();
  });

  it('ignores degenerate food queries that echo the whole meal text', async () => {
    // Bonsai occasionally echoes the entire meal as foodQuery; the resolver
    // must drop it and match from the raw ingredient name only.
    const search = async (q: string) =>
      q === 'queso fresco' || q === 'fresco' || q === 'queso' ? [RICE] : [];
    const props = await resolveDraft(
      draft([
        {
          raw: 'queso fresco',
          foodQuery: 'lecsó with peppers, onion, and queso fresco',
          amount: 1,
          servingLabel: null,
        },
      ]),
      search,
    );
    const p = props[0]!;
    expect(p.food?.id).toBe('f-rice');
  });
});
