/**
 * Deterministic draft → entry mapping. The model never picks foods or
 * computes anything: each extracted ingredient is matched to the top catalog
 * hit for its foodQuery, the serving is matched case-insensitively (fallback:
 * the food's first serving), and a missing amount defaults to 1. Unmatched
 * ingredients yield `food: null` and are skipped with a note, never guessed.
 */
import type { Food } from '@/domain/types';
import type { MealDraft, MealIngredient } from './types';

export interface DraftEntryProposal {
  ingredient: MealIngredient;
  food: Food | null;
  servingId: string | null;
  amount: number;
}

export async function resolveDraft(
  draft: MealDraft,
  search: (query: string, limit: number) => Promise<Food[]>,
): Promise<DraftEntryProposal[]> {
  const proposals: DraftEntryProposal[] = [];
  for (const ingredient of draft.ingredients) {
    const fallback = { ingredient, food: null, servingId: null, amount: ingredient.amount ?? 1 };
    const query = ingredient.foodQuery?.trim();
    // Degenerate extraction sometimes echoes the whole meal as foodQuery;
    // treat over-long queries as missing and fall back to the raw name.
    if (!query || query.length > 40) {
      proposals.push(await resolveWithRaw(ingredient, fallback, search));
      continue;
    }
    const hit = await findBestMatch(query, ingredient.raw, search);
    if (!hit) {
      proposals.push(fallback);
      continue;
    }
    const label = (ingredient.servingLabel ?? '').toLowerCase();
    const serving =
      hit.servings.find((s) => s.label.toLowerCase() === label) ?? hit.servings[0] ?? null;
    proposals.push({
      ingredient,
      food: hit,
      servingId: serving?.id ?? null,
      amount: ingredient.amount ?? 1,
    });
  }
  return proposals;
}

async function resolveWithRaw(
  ingredient: MealIngredient,
  fallback: DraftEntryProposal,
  search: (query: string, limit: number) => Promise<Food[]>,
): Promise<DraftEntryProposal> {
  const raw = ingredient.raw?.trim();
  if (!raw) return fallback;
  const hit = await findBestMatch('', raw, search);
  if (!hit) return fallback;
  const label = (ingredient.servingLabel ?? '').toLowerCase();
  const serving =
    hit.servings.find((s) => s.label.toLowerCase() === label) ?? hit.servings[0] ?? null;
  return { ingredient, food: hit, servingId: serving?.id ?? null, amount: ingredient.amount ?? 1 };
}

/**
 * Deterministic catalog matching: exact-phrase substring first, then the
 * longest words of the query/raw name (the catalog is substring-based, so
 * "greek yogurt" must fall back to "greek" to find "Yogurt, Greek, plain").
 */
async function findBestMatch(
  foodQuery: string,
  raw: string,
  search: (query: string, limit: number) => Promise<Food[]>,
): Promise<Food | null> {
  const candidates = [foodQuery, raw];
  for (const q of candidates) {
    if (!q?.trim()) continue;
    const [hit] = await search(q.trim(), 1);
    if (hit) return hit;
  }
  const words = new Set<string>();
  for (const source of [foodQuery, raw]) {
    for (const w of source.split(/\s+/)) {
      const clean = w.replace(/[^a-z0-9à-öø-ÿ]+/gi, '').toLowerCase();
      if (clean.length >= 3) words.add(clean);
    }
  }
  const byLength = [...words].sort((a, b) => b.length - a.length);
  for (const w of byLength) {
    const [hit] = await search(w, 1);
    if (hit) return hit;
  }
  return null;
}
