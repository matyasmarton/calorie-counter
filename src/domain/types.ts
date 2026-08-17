/**
 * Shared domain model for the calorie counter.
 * All persisted rows carry UUID ids plus `updatedAt`/`deletedAt` for sync;
 * deletes are tombstones so offline corrections propagate to other devices.
 */

/** A household measure expressed as grams per single unit. */
export interface Serving {
  id: string;
  /** Display label: "cup", "tbsp", "g", "oz", "handful", "piece", ... */
  label: string;
  /** Grams per 1 unit of this serving. */
  grams: number;
  /** True when derived from an estimate (handful, density-based, manual size). */
  approx: boolean;
}

/** Seeded catalog row (source "catalog") or user-created row (source "user"). */
export interface Food {
  id: string;
  name: string;
  /** Free-form category used for grouping in the picker. */
  category: string;
  /** Integer kilocalories per 100 g. */
  caloriesPer100g: number;
  /** Grams of protein per 100 g; null for legacy rows without USDA macro data. */
  proteinPer100g: number | null;
  /** Grams of carbohydrate per 100 g; null for legacy rows without USDA macro data. */
  carbsPer100g: number | null;
  /** Grams of total fat per 100 g; null for legacy rows without USDA macro data. */
  fatPer100g: number | null;
  servings: Serving[];
  source: 'catalog' | 'user';
  /** Owner auth id — set only for user rows; null for catalog rows. */
  ownerId: string | null;
  /** Provenance string for catalog rows, e.g. "USDA FDC 321900 · Broccoli, raw …". */
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** A user-created food (alias with narrowed source; kept as its own type per the domain spec). */
export interface UserFood extends Food {
  source: 'user';
  ownerId: string | null;
}

/** One logged serving of a food on a calendar day. */
export interface DailyEntry {
  id: string;
  /** ISO calendar date (YYYY-MM-DD), local timezone. */
  logDate: string;
  foodId: string;
  /** Nutrient/food snapshots retained so catalog changes never rewrite history. */
  foodName: string;
  caloriesPer100g: number;
  servingId: string;
  servingLabel: string;
  servingGrams: number;
  /** Number of servings. */
  amount: number;
  /** amount × servingGrams, rounded to 1 decimal. */
  grams: number;
  /** Whole calories computed at write time. */
  calories: number;
  /** Snapshot grams of protein at write time; null for legacy entries. */
  proteinGrams: number | null;
  /** Snapshot grams of carbohydrate at write time; null for legacy entries. */
  carbsGrams: number | null;
  /** Snapshot grams of total fat at write time; null for legacy entries. */
  fatGrams: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** A date-keyed weight and/or height measurement. */
export interface HealthMeasurement {
  id: string;
  /** ISO calendar date (YYYY-MM-DD), local timezone. */
  measuredAt: string;
  /** At least one of weightKg/heightCm must be set. */
  weightKg: number | null;
  heightCm: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** Per-day rollup: intake plus the latest measurement at or before the date. */
export interface DailySummary {
  logDate: string;
  calories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  entryCount: number;
  /** Latest measurement with measuredAt <= logDate (null when none exists yet). */
  weightKg: number | null;
  heightCm: number | null;
}

/** Explicit aggregation window for calorie/macro totals. */
export type SummaryRange = 'day' | 'week' | 'month';

/** Totals over an explicit range (day, ISO week, or calendar month). */
export interface MacroSummary {
  range: SummaryRange;
  /** Inclusive start date key (YYYY-MM-DD, local). */
  from: string;
  /** Inclusive end date key (YYYY-MM-DD, local). */
  to: string;
  calories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  entryCount: number;
}

export type SyncTable = 'foods' | 'daily_entries' | 'health_measurements' | 'saved_recipes';

/** Queue row describing one local change awaiting push. */
export interface SyncRecord {
  /** Same UUID as the record it describes — pushes are idempotent. */
  id: string;
  table: SyncTable;
  op: 'upsert' | 'delete';
  updatedAt: string;
  pushedAt: string | null;
  error: string | null;
}

/** Provenance/version record for the seeded catalog. */
export interface CatalogMetadata {
  id: string;
  sourceName: string;
  sourceUrl: string;
  version: string;
  license: string;
  foodCount: number;
  importedAt: string;
  notes: string;
}

/** A confirmed localized recipe/alias saved with explicit user consent. */
export interface SavedRecipe {
  id: string;
  /** User's name, e.g. "Mom's hamburger" / "lecsó". */
  name: string;
  /** Ingredient list as confirmed by the user (amounts + serving labels). */
  ingredients: Array<{
    raw: string;
    foodQuery: string | null;
    amount: number | null;
    servingLabel: string | null;
  }>;
  /** Resolved catalog food ids per ingredient (deterministic matching only). */
  foodIds: string[];
  /** Snapshot: calculated per-serving grams/calories/macros at save time. */
  servingGrams: number;
  calories: number;
  proteinGrams: number | null;
  carbsGrams: number | null;
  fatGrams: number | null;
  /** Aliases this recipe can be found under ("mom's burger", …). */
  aliases: string[];
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
