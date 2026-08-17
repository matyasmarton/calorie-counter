/**
 * Local-AI contracts: which models exist, what a parsed meal draft looks
 * like, and how confirmed localized recipes are persisted. The app works
 * fully without any model installed — every model id is opt-in and gated by
 * runtime availability and device benchmarks.
 */

/** Models the app knows about. Weights are never bundled; downloads are opt-in. */
export type LocalModelId = 'needle-2' | 'bonsai-4b' | 'bonsai-8b-1bit';

export type LocalModelPlatform = 'android' | 'desktop';

export type LocalModelStatus = 'unavailable' | 'downloading' | 'ready' | 'error';

export interface LocalModelState {
  id: LocalModelId;
  platform: LocalModelPlatform;
  status: LocalModelStatus;
  /** Human-readable reason when unavailable/error (e.g. "Expo Go has no native modules"). */
  detail: string | null;
  /** Benchmark gates passed (see benchmark fixture) before a model can be default. */
  benchmarkPassed: boolean;
}

/** One ingredient extracted from messy meal text (schema-only; no nutrient math). */
export interface MealIngredient {
  /** Free-text ingredient as typed by the user, e.g. "ground beef 80/20". */
  raw: string;
  /** Best-effort catalog query for deterministic matching, e.g. "ground beef". */
  foodQuery: string | null;
  /** Amount in household units, e.g. 1. */
  amount: number | null;
  /** Unit label, e.g. "cup", "piece", "g". */
  servingLabel: string | null;
}

/** Structured, schema-validated output of the Needle 2 parser. */
export interface MealDraft {
  /** The user's original text, echoed back for the review screen. */
  mealDescription: string;
  ingredients: MealIngredient[];
  /** 0–1 model confidence; below 0.8 the draft must be reviewed. */
  confidence: number;
  /** True when any ingredient is missing an amount/serving/food query. */
  needsReview: boolean;
}

import type { SavedRecipe as DomainSavedRecipe } from '@/domain/types';

/** A confirmed localized recipe/alias saved with explicit user consent. */
export type SavedRecipe = DomainSavedRecipe;

/** Gate thresholds applied by the benchmark fixture before enabling defaults. */
export const BENCHMARK_GATES = {
  /** Fraction of schema-valid structured drafts over the prompt set. */
  minSchemaValidity: 0.95,
  /** p95 time to first token across the prompt set, in seconds. */
  maxP95FirstTokenSeconds: 5,
  maxForceCloses: 0,
} as const;
