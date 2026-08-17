/**
 * Repository — the single validated read/write boundary for the app.
 * Screens and the sync engine call ONLY these methods; they never touch
 * storage adapters directly.
 *
 * Rules enforced here:
 *  - dates are valid ISO calendar keys
 *  - amounts are finite and > 0; servings must exist on the food
 *  - weight/height are finite and positive when present
 *  - every write stamps updatedAt and queues the record for sync
 *  - deletes are tombstones (deletedAt), never physical removal
 *  - entries snapshot food/serving values at write time
 */
import { calculateCalories, servingAmountToGrams } from '@/domain/calories';
import { calculateMacros } from '@/domain/macros';
import { isValidDateKey, todayKey } from '@/domain/dates';
import type {
  CatalogMetadata,
  DailyEntry,
  DailySummary,
  Food,
  HealthMeasurement,
  MacroSummary,
  SavedRecipe,
  Serving,
  SummaryRange,
  SyncRecord,
  SyncTable,
  UserFood,
} from '@/domain/types';
import type { MealIngredient } from '@/local-ai/types';
import { uuid } from '@/domain/uuid';
import { CATALOG_VERSION_KEY, seedCatalog, type CatalogBundle } from './seedCatalog';
import type { Row, StorageAdapter } from './storage';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export interface NewEntryInput {
  logDate: string;
  foodId: string;
  servingId: string;
  amount: number;
}

export interface FoodInput {
  name: string;
  category?: string;
  caloriesPer100g: number;
  /** Grams per 100 g; null keeps legacy behavior ("Macros unavailable"). */
  proteinPer100g: number | null;
  carbsPer100g: number | null;
  fatPer100g: number | null;
  servings: Serving[];
}

export interface MeasurementInput {
  measuredAt: string;
  weightKg: number | null;
  heightCm: number | null;
}

export interface BackupPayload {
  app: 'calorie-counter';
  version: 2;
  exportedAt: string;
  userFoods: UserFood[];
  entries: DailyEntry[];
  measurements: HealthMeasurement[];
}

function assertDate(key: string, label = 'date'): void {
  if (!isValidDateKey(key)) throw new ValidationError(`Invalid ${label} "${key}" (expected YYYY-MM-DD)`);
}

function assertAmount(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`Amount must be a finite number greater than 0 (got ${value})`);
  }
}

function assertPositiveNullable(value: number | null, label: string): void {
  if (value != null && (!Number.isFinite(value) || value <= 0)) {
    throw new ValidationError(`${label} must be a positive number (got ${value})`);
  }
}

function assertServing(s: Serving): void {
  if (!s || typeof s.label !== 'string' || s.label.trim() === '') {
    throw new ValidationError('Serving must have a label');
  }
  if (!Number.isFinite(s.grams) || s.grams <= 0) {
    throw new ValidationError(`Serving "${s.label}" grams must be a positive number`);
  }
}

/** Nullable macros are valid (legacy rows); present values must be finite and non-negative. */
function assertMacroNullable(value: number | null | undefined, label: string): void {
  if (value == null) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${label} must be a non-negative number`);
  }
}

export class Repository {
  constructor(private readonly db: StorageAdapter) {}

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  async init(): Promise<void> {
    await this.db.init();
  }

  async ensureCatalog(bundle: CatalogBundle): Promise<void> {
    await seedCatalog(this.db, bundle);
  }

  /* ------------------------------------------------------------------ */
  /* foods                                                               */
  /* ------------------------------------------------------------------ */

  private async loadFood(id: string, includeDeleted = false): Promise<Food> {
    const row = await this.db.get('foods', id);
    if (!row) throw new NotFoundError(`Food ${id} not found`);
    const food = row as unknown as Food;
    if (!includeDeleted && food.deletedAt) throw new NotFoundError(`Food ${id} not found`);
    return food;
  }

  /** Catalog + user foods whose name contains `query`, excluding deleted. */
  async searchFoods(query: string, limit = 30): Promise<Food[]> {
    const q = query.trim().toLowerCase();
    const rows = (await this.db.query('foods', {
      filter: (r) => {
        const f = r as unknown as Food;
        return !f.deletedAt && (q === '' || f.name.toLowerCase().includes(q));
      },
    })) as unknown as Food[];
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows.slice(0, limit);
  }

  async getFood(id: string): Promise<Food> {
    return this.loadFood(id);
  }

  /** All foods a user owns (for the foods tab). */
  async getUserFoods(): Promise<UserFood[]> {
    const rows = (await this.db.query('foods', {
      index: 'source',
      lower: 'user',
      upper: 'user',
      filter: (r) => !(r as unknown as Food).deletedAt,
    })) as unknown as UserFood[];
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }

  async createUserFood(input: FoodInput, ownerId: string | null = null): Promise<UserFood> {
    const name = input.name.trim();
    if (!name) throw new ValidationError('Food name is required');
    if (!Number.isFinite(input.caloriesPer100g) || input.caloriesPer100g < 0) {
      throw new ValidationError('Calories per 100 g must be a non-negative number');
    }
    assertMacroNullable(input.proteinPer100g, 'Protein per 100 g');
    assertMacroNullable(input.carbsPer100g, 'Carbohydrates per 100 g');
    assertMacroNullable(input.fatPer100g, 'Fat per 100 g');
    if (!Array.isArray(input.servings) || input.servings.length === 0) {
      throw new ValidationError('At least one serving size is required');
    }
    input.servings.forEach(assertServing);
    const now = new Date().toISOString();
    const food: UserFood = {
      id: uuid(),
      name,
      category: input.category?.trim() || 'Custom',
      caloriesPer100g: Math.round(input.caloriesPer100g),
      proteinPer100g: input.proteinPer100g == null ? null : Math.round(input.proteinPer100g * 10) / 10,
      carbsPer100g: input.carbsPer100g == null ? null : Math.round(input.carbsPer100g * 10) / 10,
      fatPer100g: input.fatPer100g == null ? null : Math.round(input.fatPer100g * 10) / 10,
      servings: input.servings.map((s) => ({ ...s, label: s.label.trim() })),
      source: 'user',
      ownerId: ownerId ?? null,
      sourceRef: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.writeAndQueue('foods', food as unknown as Row);
    return food;
  }

  async updateUserFood(id: string, input: FoodInput): Promise<UserFood> {
    const food = await this.loadFood(id);
    if (food.source !== 'user') throw new ValidationError('Catalog foods cannot be edited');
    const name = input.name.trim();
    if (!name) throw new ValidationError('Food name is required');
    if (!Number.isFinite(input.caloriesPer100g) || input.caloriesPer100g < 0) {
      throw new ValidationError('Calories per 100 g must be a non-negative number');
    }
    assertMacroNullable(input.proteinPer100g, 'Protein per 100 g');
    assertMacroNullable(input.carbsPer100g, 'Carbohydrates per 100 g');
    assertMacroNullable(input.fatPer100g, 'Fat per 100 g');
    if (!Array.isArray(input.servings) || input.servings.length === 0) {
      throw new ValidationError('At least one serving size is required');
    }
    input.servings.forEach(assertServing);
    const updated: UserFood = {
      ...food,
      source: 'user',
      name,
      category: input.category?.trim() || food.category,
      caloriesPer100g: Math.round(input.caloriesPer100g),
      proteinPer100g: input.proteinPer100g == null ? null : Math.round(input.proteinPer100g * 10) / 10,
      carbsPer100g: input.carbsPer100g == null ? null : Math.round(input.carbsPer100g * 10) / 10,
      fatPer100g: input.fatPer100g == null ? null : Math.round(input.fatPer100g * 10) / 10,
      servings: input.servings.map((s) => ({ ...s, label: s.label.trim() })),
      updatedAt: new Date().toISOString(),
    };
    await this.writeAndQueue('foods', updated as unknown as Row);
    return updated;
  }

  /** Tombstone a user food; entries keep their snapshots. */
  async deleteUserFood(id: string): Promise<void> {
    const food = await this.loadFood(id);
    if (food.source !== 'user') throw new ValidationError('Catalog foods cannot be deleted');
    await this.tombstoneAndQueue('foods', id);
  }

  /* ------------------------------------------------------------------ */
  /* daily entries                                                       */
  /* ------------------------------------------------------------------ */

  private async loadEntry(id: string): Promise<DailyEntry> {
    const row = await this.db.get('daily_entries', id);
    if (!row) throw new NotFoundError(`Entry ${id} not found`);
    const entry = row as unknown as DailyEntry;
    if (entry.deletedAt) throw new NotFoundError(`Entry ${id} not found`);
    return entry;
  }

  /** Entries for one local calendar day, newest-created first. */
  async getDailyEntries(date: string): Promise<DailyEntry[]> {
    assertDate(date);
    const rows = (await this.db.query('daily_entries', {
      index: 'logDate',
      lower: date,
      upper: date,
      filter: (r) => !(r as unknown as DailyEntry).deletedAt,
    })) as unknown as DailyEntry[];
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return rows;
  }

  async addEntry(input: NewEntryInput): Promise<DailyEntry> {
    assertDate(input.logDate);
    assertAmount(input.amount);
    const food = await this.loadFood(input.foodId);
    const serving = food.servings.find((s) => s.id === input.servingId);
    if (!serving) {
      throw new ValidationError(`Serving "${input.servingId}" is not available for ${food.name}`);
    }
    const grams = servingAmountToGrams(serving, input.amount);
    const calories = calculateCalories(food.caloriesPer100g, input.amount, serving.grams);
    const macroSnap =
      food.proteinPer100g != null && food.carbsPer100g != null && food.fatPer100g != null
        ? calculateMacros(food.proteinPer100g, food.carbsPer100g, food.fatPer100g, input.amount, serving.grams)
        : null;
    const now = new Date().toISOString();
    const entry: DailyEntry = {
      id: uuid(),
      logDate: input.logDate,
      foodId: food.id,
      foodName: food.name,
      caloriesPer100g: food.caloriesPer100g,
      proteinGrams: macroSnap?.proteinGrams ?? null,
      carbsGrams: macroSnap?.carbsGrams ?? null,
      fatGrams: macroSnap?.fatGrams ?? null,
      servingId: serving.id,
      servingLabel: serving.label,
      servingGrams: serving.grams,
      amount: input.amount,
      grams,
      calories,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.writeAndQueue('daily_entries', entry as unknown as Row);
    return entry;
  }

  async updateEntry(
    id: string,
    patch: { servingId?: string; amount?: number },
  ): Promise<DailyEntry> {
    const entry = await this.loadEntry(id);
    const amount = patch.amount ?? entry.amount;
    assertAmount(amount);
    const food = await this.loadFood(entry.foodId, true);
    const serving =
      (patch.servingId != null
        ? food.servings.find((s) => s.id === patch.servingId)
        : food.servings.find((s) => s.id === entry.servingId)) ?? null;
    if (!serving) {
      throw new ValidationError(`Serving is not available for ${food.name}`);
    }
    const grams = servingAmountToGrams(serving, amount);
    const calories = calculateCalories(food.caloriesPer100g, amount, serving.grams);
    const macroSnap =
      food.proteinPer100g != null && food.carbsPer100g != null && food.fatPer100g != null
        ? calculateMacros(food.proteinPer100g, food.carbsPer100g, food.fatPer100g, amount, serving.grams)
        : null;
    const updated: DailyEntry = {
      ...entry,
      servingId: serving.id,
      servingLabel: serving.label,
      servingGrams: serving.grams,
      amount,
      grams,
      calories,
      proteinGrams: macroSnap?.proteinGrams ?? null,
      carbsGrams: macroSnap?.carbsGrams ?? null,
      fatGrams: macroSnap?.fatGrams ?? null,
      updatedAt: new Date().toISOString(),
    };
    await this.writeAndQueue('daily_entries', updated as unknown as Row);
    return updated;
  }

  async deleteEntry(id: string): Promise<void> {
    await this.loadEntry(id);
    await this.tombstoneAndQueue('daily_entries', id);
  }

  /* ------------------------------------------------------------------ */
  /* health measurements                                                 */
  /* ------------------------------------------------------------------ */

  private async loadMeasurement(id: string): Promise<HealthMeasurement> {
    const row = await this.db.get('health_measurements', id);
    if (!row) throw new NotFoundError(`Measurement ${id} not found`);
    const m = row as unknown as HealthMeasurement;
    if (m.deletedAt) throw new NotFoundError(`Measurement ${id} not found`);
    return m;
  }

  /** Measurements within [from, to] (inclusive), newest date first. */
  async getHealthMeasurements(from?: string, to?: string): Promise<HealthMeasurement[]> {
    if (from) assertDate(from, 'from date');
    if (to) assertDate(to, 'to date');
    const rows = (await this.db.query('health_measurements', {
      index: 'measuredAt',
      lower: from ?? undefined,
      upper: to ?? undefined,
      filter: (r) => !(r as unknown as HealthMeasurement).deletedAt,
    })) as unknown as HealthMeasurement[];
    rows.sort((a, b) => (a.measuredAt < b.measuredAt ? 1 : -1));
    return rows;
  }

  async addHealthMeasurement(input: MeasurementInput): Promise<HealthMeasurement> {
    assertDate(input.measuredAt, 'measurement date');
    assertPositiveNullable(input.weightKg, 'Weight');
    assertPositiveNullable(input.heightCm, 'Height');
    if (input.weightKg == null && input.heightCm == null) {
      throw new ValidationError('Enter a weight, a height, or both');
    }
    const now = new Date().toISOString();
    const m: HealthMeasurement = {
      id: uuid(),
      measuredAt: input.measuredAt,
      weightKg: input.weightKg,
      heightCm: input.heightCm,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.writeAndQueue('health_measurements', m as unknown as Row);
    return m;
  }

  async updateHealthMeasurement(
    id: string,
    patch: MeasurementInput,
  ): Promise<HealthMeasurement> {
    const m = await this.loadMeasurement(id);
    assertDate(patch.measuredAt, 'measurement date');
    assertPositiveNullable(patch.weightKg, 'Weight');
    assertPositiveNullable(patch.heightCm, 'Height');
    if (patch.weightKg == null && patch.heightCm == null) {
      throw new ValidationError('Enter a weight, a height, or both');
    }
    const updated: HealthMeasurement = {
      ...m,
      measuredAt: patch.measuredAt,
      weightKg: patch.weightKg,
      heightCm: patch.heightCm,
      updatedAt: new Date().toISOString(),
    };
    await this.writeAndQueue('health_measurements', updated as unknown as Row);
    return updated;
  }

  async deleteHealthMeasurement(id: string): Promise<void> {
    await this.loadMeasurement(id);
    await this.tombstoneAndQueue('health_measurements', id);
  }

  /** Latest measurement with measuredAt <= date, or null. */
  async getLatestHealthBefore(date: string): Promise<HealthMeasurement | null> {
    assertDate(date);
    const rows = await this.getHealthMeasurements(undefined, date);
    return rows[0] ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* localized recipe memory (consent-gated)                            */
  /* ------------------------------------------------------------------ */

  /**
   * Search saved recipes by name/alias. Only recipes the user explicitly
   * confirmed (via saveRecipeWithConsent) are ever stored.
   */
  async searchRecipes(query: string, limit = 10): Promise<SavedRecipe[]> {
    const q = query.trim().toLowerCase();
    const rows = (await this.db.query('saved_recipes', {
      filter: (r) => {
        const rec = r as unknown as SavedRecipe;
        if (rec.deletedAt) return false;
        if (q === '') return true;
        return (
          rec.name.toLowerCase().includes(q) ||
          rec.aliases.some((a: string) => a.toLowerCase().includes(q))
        );
      },
    })) as unknown as SavedRecipe[];
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows.slice(0, limit);
  }

  /**
   * Save a confirmed localized recipe. Deterministic ingredient→food
   * resolution happens BEFORE this call; the caller passes the resolved
   * food ids and the calculated snapshot. Never call this without an
   * explicit `Save this recipe for future searches?` confirmation.
   */
  async saveRecipe(
    input: {
      name: string;
      ingredients: MealIngredient[];
      foodIds: string[];
      servingGrams: number;
      aliases?: string[];
      ownerId?: string | null;
    },
  ): Promise<SavedRecipe> {
    const name = input.name.trim();
    if (!name) throw new ValidationError('Recipe name is required');
    if (!Array.isArray(input.ingredients) || input.ingredients.length === 0) {
      throw new ValidationError('A recipe needs at least one ingredient');
    }
    if (!Array.isArray(input.foodIds) || input.foodIds.length !== input.ingredients.length) {
      throw new ValidationError('Every ingredient must resolve to one catalog food');
    }
    for (const id of input.foodIds) {
      const food = await this.db.get('foods', id);
      if (!food) throw new NotFoundError(`Food ${id} not found`);
    }
    if (!Number.isFinite(input.servingGrams) || input.servingGrams <= 0) {
      throw new ValidationError('Recipe serving grams must be positive');
    }
    const now = new Date().toISOString();
    const recipe: SavedRecipe = {
      id: uuid(),
      name,
      ingredients: input.ingredients,
      foodIds: input.foodIds,
      servingGrams: Math.round(input.servingGrams * 10) / 10,
      calories: 0,
      proteinGrams: null,
      carbsGrams: null,
      fatGrams: null,
      aliases: (input.aliases ?? []).map((a) => a.trim()).filter(Boolean),
      ownerId: input.ownerId ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.writeAndQueue('saved_recipes', recipe as unknown as Row);
    return recipe;
  }

  /** Tombstone a saved recipe (consent can be withdrawn). */
  async deleteRecipe(id: string): Promise<void> {
    const row = await this.db.get('saved_recipes', id);
    if (!row) throw new NotFoundError(`Recipe ${id} not found`);
    await this.tombstoneAndQueue('saved_recipes', id);
  }


  async getMacroSummary(range: SummaryRange, anchorDate: string): Promise<MacroSummary> {
    assertDate(anchorDate, 'anchor date');
    const { from, to } = rangeBounds(range, anchorDate);
    const entries = (await this.db.query('daily_entries', {
      index: 'logDate',
      lower: from,
      upper: to,
      filter: (r) => !(r as unknown as DailyEntry).deletedAt,
    })) as unknown as DailyEntry[];
    const sum = { calories: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, entryCount: 0 };
    for (const e of entries) {
      sum.calories += e.calories;
      sum.proteinGrams += e.proteinGrams ?? 0;
      sum.carbsGrams += e.carbsGrams ?? 0;
      sum.fatGrams += e.fatGrams ?? 0;
      sum.entryCount += 1;
    }
    return {
      range,
      from,
      to,
      calories: sum.calories,
      proteinGrams: roundMacroSum(sum.proteinGrams),
      carbsGrams: roundMacroSum(sum.carbsGrams),
      fatGrams: roundMacroSum(sum.fatGrams),
      entryCount: sum.entryCount,
    };
  }

  /**
   * One DailySummary per date in [from, to] that has any data (food entries
   * or a measurement at or before that date). Missing dates are absent from
   * the result so charts render them as gaps, never as zero intake/weight.
   */
  async getDailySummaries(from: string, to: string): Promise<DailySummary[]> {
    assertDate(from, 'from date');
    assertDate(to, 'to date');
    if (from > to) throw new ValidationError('from date must be <= to date');

    const entries = (await this.db.query('daily_entries', {
      index: 'logDate',
      lower: from,
      upper: to,
      filter: (r) => !(r as unknown as DailyEntry).deletedAt,
    })) as unknown as DailyEntry[];

    const allMeasurements = (await this.db.query('health_measurements', {
      index: 'measuredAt',
      upper: to,
      filter: (r) => !(r as unknown as HealthMeasurement).deletedAt,
    })) as unknown as HealthMeasurement[];
    allMeasurements.sort((a, b) => (a.measuredAt < b.measuredAt ? -1 : 1)); // ascending

    const byDate = new Map<string, { calories: number; proteinGrams: number; carbsGrams: number; fatGrams: number; entryCount: number }>();
    for (const e of entries) {
      const agg = byDate.get(e.logDate) ?? { calories: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0, entryCount: 0 };
      agg.calories += e.calories;
      agg.proteinGrams += e.proteinGrams ?? 0;
      agg.carbsGrams += e.carbsGrams ?? 0;
      agg.fatGrams += e.fatGrams ?? 0;
      agg.entryCount += 1;
      byDate.set(e.logDate, agg);
    }

    const out: DailySummary[] = [];
    let mi = 0; // pointer into ascending measurements: latest with measuredAt <= current day
    let d = from;
    while (d <= to) {
      while (mi < allMeasurements.length && allMeasurements[mi]!.measuredAt <= d) mi++;
      const latest = mi > 0 ? allMeasurements[mi - 1]! : null;
      const agg = byDate.get(d);
      if (agg || latest) {
        out.push({
          logDate: d,
          calories: agg?.calories ?? 0,
          proteinGrams: roundMacroSum(agg?.proteinGrams ?? 0),
          carbsGrams: roundMacroSum(agg?.carbsGrams ?? 0),
          fatGrams: roundMacroSum(agg?.fatGrams ?? 0),
          entryCount: agg?.entryCount ?? 0,
          weightKg: latest?.weightKg ?? null,
          heightCm: latest?.heightCm ?? null,
        });
      }
      d = nextDateKey(d);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* sync                                                                */
  /* ------------------------------------------------------------------ */

  async getUnsyncedChanges(): Promise<SyncRecord[]> {
    const rows = (await this.db.query('sync_queue', {
      filter: (r) => (r as unknown as SyncRecord).pushedAt == null,
    })) as unknown as SyncRecord[];
    rows.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
    return rows;
  }

  /** Mark queue rows as pushed only after a confirmed server response. */
  async markSynced(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const rows = await this.db.query('sync_queue', { filter: (r) => ids.includes(String(r.id)) });
    for (const row of rows) {
      await this.db.put('sync_queue', { ...row, pushedAt: now, error: null });
    }
  }

  async setSyncError(id: string, error: string | null): Promise<void> {
    const row = await this.db.get('sync_queue', id);
    if (row) await this.db.put('sync_queue', { ...row, error });
  }

  /** All live rows of a syncable table (including deleted tombstones). */
  async listForSync(table: SyncTable): Promise<Row[]> {
    return this.db.query(table);
  }

  /** Fetch one row (including tombstones) — used by the sync engine to push. */
  async getRow(table: SyncTable, id: string): Promise<Row | null> {
    return this.db.get(table, id);
  }

  async getSyncMeta(key: string): Promise<string | null> {
    const row = await this.db.get('sync_meta', key);
    return row ? String(row.value) : null;
  }

  async putSyncMeta(key: string, value: string): Promise<void> {
    await this.db.put('sync_meta', { id: key, key, value, updatedAt: new Date().toISOString() });
  }

  /**
   * Apply remote rows with newest-updatedAt-wins semantics. Tombstones
   * (deletedAt set) overwrite local rows so deletions propagate.
   */
  async applyRemote(table: SyncTable, remoteRows: Row[]): Promise<number> {
    let applied = 0;
    for (const remote of remoteRows) {
      const id = String(remote.id);
      const local = await this.db.get(table, id);
      if (local && String(local.updatedAt) > String(remote.updatedAt)) continue; // local wins
      await this.db.put(table, remote);
      applied++;
    }
    return applied;
  }

  async getCatalogMetadata(): Promise<CatalogMetadata | null> {
    const row = await this.db.get('catalog_metadata', CATALOG_VERSION_KEY);
    return row ? (row as unknown as CatalogMetadata) : null;
  }

  /* ------------------------------------------------------------------ */
  /* backup export / import                                              */
  /* ------------------------------------------------------------------ */

  /** JSON backup of all user data (live rows only; tombstones excluded). */
  async exportBackup(): Promise<BackupPayload> {
    const userFoods = await this.getUserFoods();
    const entries = (await this.listForSync('daily_entries'))
      .filter((r) => !r.deletedAt) as unknown as DailyEntry[];
    const measurements = (await this.listForSync('health_measurements'))
      .filter((r) => !r.deletedAt) as unknown as HealthMeasurement[];
    return {
      app: 'calorie-counter',
      version: 2,
      exportedAt: new Date().toISOString(),
      userFoods,
      entries,
      measurements,
    };
  }

  /**
   * Import a backup. `restore: false` merges by UUID (newest updatedAt wins,
   * existing rows are kept); `restore: true` first clears all user data
   * (user foods, entries, measurements, sync queue — never catalog rows),
   * then inserts the backup. Imported rows are queued for sync.
   */
  async importBackup(
    payload: unknown,
    opts: { restore: boolean },
  ): Promise<{ userFoods: number; entries: number; measurements: number }> {
    const data = payload as { version?: unknown; app?: unknown; userFoods?: unknown[]; entries?: unknown[]; measurements?: unknown[] };
    if (
      !data ||
      typeof data !== 'object' ||
      data.app !== 'calorie-counter' ||
      !Array.isArray(data.userFoods) ||
      !Array.isArray(data.entries) ||
      !Array.isArray(data.measurements)
    ) {
      throw new ValidationError('Not a valid calorie-counter backup');
    }
    if (data.version !== 1 && data.version !== 2) {
      throw new ValidationError(`Unsupported backup version ${String(data.version)}`);
    }
    const foods = data.userFoods as unknown as Food[];
    const entries = data.entries as unknown as DailyEntry[];
    const measurements = data.measurements as unknown as HealthMeasurement[];
    // version-1 backups have no macro columns; normalize to null (legacy)
    if (data.version === 1) {
      for (const f of foods) {
        f.proteinPer100g = null;
        f.carbsPer100g = null;
        f.fatPer100g = null;
      }
      for (const e of entries) {
        e.proteinGrams = null;
        e.carbsGrams = null;
        e.fatGrams = null;
      }
    }
    for (const f of foods) {
      if (typeof f.id !== 'string' || typeof f.updatedAt !== 'string' || f.source !== 'user') {
        throw new ValidationError('Backup contains an invalid user food');
      }
      assertMacroNullable(f.proteinPer100g, 'Protein per 100 g');
      assertMacroNullable(f.carbsPer100g, 'Carbohydrates per 100 g');
      assertMacroNullable(f.fatPer100g, 'Fat per 100 g');
    }
    for (const e of entries) {
      if (typeof e.id !== 'string' || typeof e.updatedAt !== 'string' || typeof e.logDate !== 'string') {
        throw new ValidationError('Backup contains an invalid daily entry');
      }
      assertMacroNullable(e.proteinGrams, 'Protein grams');
      assertMacroNullable(e.carbsGrams, 'Carbohydrate grams');
      assertMacroNullable(e.fatGrams, 'Fat grams');
    }
    for (const m of measurements) {
      if (typeof m.id !== 'string' || typeof m.updatedAt !== 'string' || typeof m.measuredAt !== 'string') {
        throw new ValidationError('Backup contains an invalid measurement');
      }
    }

    if (opts.restore) {
      const userFoods = await this.getUserFoods();
      for (const f of userFoods) await this.db.remove('foods', f.id);
      await this.db.clear('daily_entries');
      await this.db.clear('health_measurements');
      await this.db.clear('sync_queue');
    }

    const merged = async <T extends { id: string; updatedAt: string }>(table: SyncTable, rows: T[]) => {
      let applied = 0;
      for (const row of rows) {
        const local = await this.db.get(table, row.id);
        if (local && String(local.updatedAt) > row.updatedAt) continue;
        await this.writeAndQueue(table as SyncTable, row as unknown as Row);
        applied++;
      }
      return applied;
    };

    return {
      userFoods: await merged<Food>('foods', foods),
      entries: await merged<DailyEntry>('daily_entries', entries),
      measurements: await merged<HealthMeasurement>('health_measurements', measurements),
    };
  }

  /* ------------------------------------------------------------------ */
  /* internals                                                           */
  /* ------------------------------------------------------------------ */

  private async writeAndQueue(table: SyncTable, row: Row): Promise<void> {
    await this.db.put(table, row);
    const record: SyncRecord = {
      id: String(row.id),
      table,
      op: 'upsert',
      updatedAt: String(row.updatedAt),
      pushedAt: null,
      error: null,
    };
    await this.db.put('sync_queue', record as unknown as Row);
  }

  private async tombstoneAndQueue(table: SyncTable, id: string): Promise<void> {
    const row = await this.db.get(table, id);
    if (!row) throw new NotFoundError(`${table} row ${id} not found`);
    const updated = { ...row, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await this.db.put(table, updated);
    const record: SyncRecord = {
      id,
      table,
      op: 'delete',
      updatedAt: String(updated.updatedAt),
      pushedAt: null,
      error: null,
    };
    await this.db.put('sync_queue', record as unknown as Row);
  }

  /** For tests/UI convenience: the local "today" key. */
  today(): string {
    return todayKey();
  }
}

function nextDateKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d + 1);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Local-calendar bounds for a day, ISO Monday–Sunday week, or calendar month. */
function rangeBounds(range: SummaryRange, anchorDate: string): { from: string; to: string } {
  const [y, m, d] = anchorDate.split('-').map(Number) as [number, number, number];
  if (range === 'day') return { from: anchorDate, to: anchorDate };
  if (range === 'week') {
    // ISO week: Monday = 1 ... Sunday = 7. daysSinceMonday = (jsDay + 6) % 7.
    const jsDay = new Date(y, m - 1, d).getDay();
    const daysSinceMonday = (jsDay + 6) % 7;
    const monday = new Date(y, m - 1, d - daysSinceMonday);
    const sunday = new Date(y, m - 1, d - daysSinceMonday + 6);
    return { from: keyOf(monday), to: keyOf(sunday) };
  }
  const lastDay = new Date(y, m, 0).getDate();
  return { from: `${anchorDate.slice(0, 8)}01`, to: `${anchorDate.slice(0, 8)}${String(lastDay).padStart(2, '0')}` };
}

function keyOf(dt: Date): string {
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** One-decimal rounding for aggregated macro gram totals. */
function roundMacroSum(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}
