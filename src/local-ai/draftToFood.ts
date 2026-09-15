/**
 * Localized-dish arithmetic: deterministic per-100 g aggregation for custom
 * foods and consent-gated recipe memory. The app — never a model — computes
 * calories and macros from catalog matches (see domain/calories + macros).
 */
import { calculateCalories, roundTo, servingAmountToGrams } from '@/domain/calories';
import { calculateMacros } from '@/domain/macros';
import type { FoodInput } from '@/db/repository';
import type { Food, Serving } from '@/domain/types';
import type { DraftEntryProposal } from './draftToEntries';
import type { MealIngredient } from './types';

/** Shape consumed by Repository.saveRecipe (see src/db/repository.ts). */
export interface RecipeInput {
  name: string;
  ingredients: MealIngredient[];
  foodIds: string[];
  servingGrams: number;
  aliases?: string[];
}

interface Resolved {
  proposal: DraftEntryProposal;
  food: Food;
  serving: Serving;
  grams: number;
}

function resolveProposals(proposals: DraftEntryProposal[]): Resolved[] {
  const out: Resolved[] = [];
  for (const p of proposals) {
    if (!p.food || !p.servingId) continue;
    const serving = p.food.servings.find((s) => s.id === p.servingId);
    if (!serving) continue;
    out.push({ proposal: p, food: p.food, serving, grams: servingAmountToGrams(serving, p.amount) });
  }
  return out;
}

/**
 * Aggregate matched ingredients into a FoodInput (per-100 g values) for
 * Repository.createUserFood. Returns null when nothing is matchable.
 * Macro fields are null when any included ingredient lacks macro data
 * (keeps the legacy "Macros unavailable" semantics).
 */
export function aggregateFoodInput(name: string, proposals: DraftEntryProposal[]): FoodInput | null {
  const resolved = resolveProposals(proposals);
  if (resolved.length === 0) return null;

  let totalGrams = 0;
  let totalCalories = 0;
  let totalProtein = 0;
  let totalCarbs = 0;
  let totalFat = 0;
  let macrosKnown = true;

  const servings: Serving[] = [{ id: '100g', label: '100 g', grams: 100, approx: false }];
  for (const r of resolved) {
    const grams = r.grams;
    totalGrams += grams;
    totalCalories += calculateCalories(r.food.caloriesPer100g, r.proposal.amount, r.serving.grams);
    servings.push({
      id: `${r.food.id}:${r.serving.id}`,
      label: `${r.food.name} · ${r.serving.label}`,
      grams: roundTo(grams, 1),
      approx: r.serving.approx,
    });
    if (
      r.food.proteinPer100g != null &&
      r.food.carbsPer100g != null &&
      r.food.fatPer100g != null
    ) {
      const m = calculateMacros(
        r.food.proteinPer100g,
        r.food.carbsPer100g,
        r.food.fatPer100g,
        r.proposal.amount,
        r.serving.grams,
      );
      totalProtein += m.proteinGrams;
      totalCarbs += m.carbsGrams;
      totalFat += m.fatGrams;
    } else {
      macrosKnown = false;
    }
  }
  if (totalGrams <= 0) return null;

  const per100 = (v: number) => roundTo((v / totalGrams) * 100, 1);
  return {
    name: name.trim(),
    category: 'Recipes',
    caloriesPer100g: Math.round((totalCalories / totalGrams) * 100),
    proteinPer100g: macrosKnown ? per100(totalProtein) : null,
    carbsPer100g: macrosKnown ? per100(totalCarbs) : null,
    fatPer100g: macrosKnown ? per100(totalFat) : null,
    servings,
  };
}

/** Build the saveRecipe input (only fully resolved ingredients; parallel arrays). */
export function buildRecipeInput(name: string, proposals: DraftEntryProposal[], aliases?: string[]): RecipeInput | null {
  const resolved = resolveProposals(proposals);
  if (resolved.length === 0) return null;
  const servingGrams = resolved.reduce((sum, r) => sum + r.grams, 0);
  if (servingGrams <= 0) return null;
  return {
    name: name.trim(),
    ingredients: resolved.map((r) => r.proposal.ingredient),
    foodIds: resolved.map((r) => r.food.id),
    servingGrams: roundTo(servingGrams, 1),
    aliases: aliases?.map((a) => a.trim()).filter(Boolean),
  };
}

/** Total grams of the matched portion of a draft (0 when nothing matched). */
export function draftGrams(proposals: DraftEntryProposal[]): number {
  return roundTo(resolveProposals(proposals).reduce((sum, r) => sum + r.grams, 0), 1);
}
