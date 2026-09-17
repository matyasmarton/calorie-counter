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
 *  - workouts snapshot the calories an estimate produced (manual override beats
 *    the HR regression, which beats the MET estimate — see domain/workouts.ts)
 */
import { calculateCalories, roundTo, servingAmountToGrams } from '@/domain/calories';
import { basalMetabolicRate } from '@/domain/bmr';
import { estimateStepsCalories } from '@/domain/steps';
import { calculateMacros } from '@/domain/macros';
import { isValidDateKey, todayKey } from '@/domain/dates';
import { netEnergy } from '@/domain/energy';
import { NotFoundError, ValidationError } from '@/domain/errors';
import { estimateWorkoutCalories, resolveAge } from '@/domain/workouts';
import type {
  ActivityCaloriesSource,
  ActivityDay,
  CatalogMetadata,
  DailyEnergy,
  DailyEntry,
  DailySummary,
  EnergySummary,
  Food,
  HealthMeasurement,
  MacroSummary,
  SavedRecipe,
  Serving,
  Sex,
  SummaryRange,
  SyncRecord,
  SyncTable,
  UserFood,
  UserProfile,
  Workout,
  WorkoutCaloriesSource,
} from '@/domain/types';
import type { MealIngredient } from '@/local-ai/types';
import { uuid } from '@/domain/uuid';
import { CATALOG_VERSION_KEY, seedCatalog, type CatalogBundle } from './seedCatalog';
import type { Row, StorageAdapter } from './storage';

/**
 * Meal nouns. If one appears after the query, the name is a dish built from
 * the ingredient — "Chicken, with pasta stew", "Beef, canned stew" — not the
 * ingredient itself, and the app's macro math would be wrong for a plain
 * "chicken" or "beef" log line.
 */
const DISH_NOUNS =
  /\b(stew|soup|salad|curry|casserole|burger|sandwich|burrito|taco|quesadilla|enchilada|lasagna|pizza|pie|cake|muffin|pancake|waffle|omelet|quiche|dumpling|stir-fry|chili|hash|croquette|nugget|meatball|gravy|stuffing|risotto|gnocchi|noodle|noodles|pasta|bowl|wrap|pot pie)\b/;

/**
 * How directly a food name answers the query; lower is a better hit.
 *
 * Catalog names lead with the head noun and qualify after a comma
 * ("Broccoli, raw"), so a query followed by a comma or the end of the name is
 * the strongest signal. Ranking matters twice over: the Foods tab lists by it,
 * and the local-AI matcher takes `search(q, 1)` as the definitive hit, so a
 * plain alphabetical sort would quietly feed "Broccoli cheese soup" to both.
 *
 * Dish names are pushed behind plain ones, but only relative to each other:
 * searching "soup" still returns soups, because then the dish noun is the
 * query itself and nothing follows it.
 */
function matchRank(name: string, query: string): number {
  const n = name.toLowerCase();
  const at = n.indexOf(query);
  const penalty = at >= 0 && DISH_NOUNS.test(n.slice(at + query.length)) ? 3 : 0;
  if (n === query) return 0;
  if (n.startsWith(query)) {
    const next = n.charAt(query.length);
    if (next === '' || next === ',') return 1 + penalty;
    return 2 + penalty;
  }
  if (n.split(/[\s,;:()/\-–]+/).some((w) => w.startsWith(query))) return 3 + penalty;
  return 4 + penalty;
}

/** The single profile row's id — one profile per device/user. */
const PROFILE_ID = 'profile';

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

export interface ActivityDayInput {
  logDate: string;
  /** Whole steps — fractional steps are meaningless, so they are rejected. */
  steps: number;
  /**
   * Entered active calories, or null to estimate them from the steps and the
   * body metrics on file. An entered value always wins.
   */
  activeKcal: number | null;
  activeMinutes: number;
}

export interface WorkoutInput {
  logDate: string;
  workoutType: string;
  durationMin: number;
  avgHr: number | null;
  peakHr: number | null;
  /** Explicit override; null lets the HR/MET estimate decide. */
  manualCalories: number | null;
  notes: string | null;
}

export interface ProfileInput {
  sex: Sex | null;
  birthYear: number | null;
}

export interface BackupPayload {
  app: 'calorie-counter';
  version: 3;
  exportedAt: string;
  userFoods: UserFood[];
  entries: DailyEntry[];
  measurements: HealthMeasurement[];
  activityDays: ActivityDay[];
  workouts: Workout[];
  profile: UserProfile | null;
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

/** Counts (steps, minutes) are whole numbers — half a step is a data error, not data. */
function assertNonNegativeInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${label} must be a whole, non-negative number (got ${value})`);
  }
}

function assertNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${label} must be a non-negative number (got ${value})`);
  }
}

function assertWorkoutInput(input: WorkoutInput): void {
  assertDate(input.logDate, 'workout date');
  if (typeof input.workoutType !== 'string' || input.workoutType.trim() === '') {
    throw new ValidationError('Workout type is required');
  }
  if (!Number.isFinite(input.durationMin) || input.durationMin <= 0) {
    throw new ValidationError(`Duration must be a positive number of minutes (got ${input.durationMin})`);
  }
  assertPositiveNullable(input.avgHr, 'Average heart rate');
  assertPositiveNullable(input.peakHr, 'Peak heart rate');
  if (input.avgHr != null && input.peakHr != null && input.peakHr < input.avgHr) {
    throw new ValidationError('Peak heart rate cannot be lower than the average');
  }
  if (input.manualCalories != null) assertNonNegative(input.manualCalories, 'Calories');
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

/** Weight and height in force on a date; either may be absent. */
interface BodyMetrics {
  weightKg: number | null;
  heightCm: number | null;
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
    const food = await this.db.get<Food>('foods', id);
    if (!food) throw new NotFoundError(`Food ${id} not found`);
    if (!includeDeleted && food.deletedAt) throw new NotFoundError(`Food ${id} not found`);
    return food;
  }

  /** Catalog + user foods whose name contains `query`, excluding deleted. */
  async searchFoods(query: string, limit = 30): Promise<Food[]> {
    const q = query.trim().toLowerCase();
    const rows = await this.db.query<Food>('foods', {
      filter: (r) => !r.deletedAt && (q === '' || r.name.toLowerCase().includes(q)),
    });
    // An empty query is a browse, so it stays alphabetical. A real query is
    // ranked, otherwise plain alphabetical order decides which hit is first —
    // and "Broccoli cheese soup" beats "Broccoli, raw" for "broccoli".
    rows.sort((a, b) =>
      q === ''
        ? a.name.localeCompare(b.name)
        : matchRank(a.name, q) - matchRank(b.name, q) ||
          a.name.length - b.name.length ||
          a.name.localeCompare(b.name),
    );
    return rows.slice(0, limit);
  }

  async getFood(id: string): Promise<Food> {
    return this.loadFood(id);
  }

  /** All foods a user owns (for the foods tab). */
  async getUserFoods(): Promise<UserFood[]> {
    const rows = await this.db.query<UserFood>('foods', {
      index: 'source',
      lower: 'user',
      upper: 'user',
      filter: (r) => !r.deletedAt,
    });
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
    await this.writeAndQueue('foods', food);
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
    await this.writeAndQueue('foods', updated);
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
    const entry = await this.db.get<DailyEntry>('daily_entries', id);
    if (!entry) throw new NotFoundError(`Entry ${id} not found`);
    if (entry.deletedAt) throw new NotFoundError(`Entry ${id} not found`);
    return entry;
  }

  /** Entries for one local calendar day, newest-created first. */
  async getDailyEntries(date: string): Promise<DailyEntry[]> {
    assertDate(date);
    const rows = await this.db.query<DailyEntry>('daily_entries', {
      index: 'logDate',
      lower: date,
      upper: date,
      filter: (r) => !r.deletedAt,
    });
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
    await this.writeAndQueue('daily_entries', entry);
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
    await this.writeAndQueue('daily_entries', updated);
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
    const m = await this.db.get<HealthMeasurement>('health_measurements', id);
    if (!m) throw new NotFoundError(`Measurement ${id} not found`);
    if (m.deletedAt) throw new NotFoundError(`Measurement ${id} not found`);
    return m;
  }

  /** Measurements within [from, to] (inclusive), newest date first. */
  async getHealthMeasurements(from?: string, to?: string): Promise<HealthMeasurement[]> {
    if (from) assertDate(from, 'from date');
    if (to) assertDate(to, 'to date');
    const rows = await this.db.query<HealthMeasurement>('health_measurements', {
      index: 'measuredAt',
      lower: from ?? undefined,
      upper: to ?? undefined,
      filter: (r) => !r.deletedAt,
    });
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
    await this.writeAndQueue('health_measurements', m);
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
    await this.writeAndQueue('health_measurements', updated);
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
  /* activity days, workouts & profile                                   */
  /* ------------------------------------------------------------------ */

  private async loadActivityDay(id: string): Promise<ActivityDay> {
    const day = await this.db.get<ActivityDay>('activity_days', id);
    if (!day) throw new NotFoundError(`Activity day ${id} not found`);
    if (day.deletedAt) throw new NotFoundError(`Activity day ${id} not found`);
    return day;
  }

  /** The live activity row for one date (one row per calendar day), or null. */
  async getActivityDay(date: string): Promise<ActivityDay | null> {
    assertDate(date, 'activity date');
    const rows = await this.getActivityDays(date, date);
    if (rows.length === 0) return null;
    return rows.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
  }

  /** Activity days within [from, to] (inclusive), newest date first. */
  async getActivityDays(from?: string, to?: string): Promise<ActivityDay[]> {
    if (from) assertDate(from, 'from date');
    if (to) assertDate(to, 'to date');
    const rows = await this.liveActivityDays(from, to);
    rows.sort((a, b) => (a.logDate < b.logDate ? 1 : -1));
    return rows;
  }

  /**
   * One live row per day. Calorie precedence mirrors the workout path: an
   * entered value is used as given, otherwise the step count is converted with
   * the body metrics in force on that date, and the source that produced the
   * number is snapshotted so a later profile or weight change never rewrites it.
   * With neither an entered value nor the metrics to estimate from, the write is
   * rejected rather than stored as a silent zero.
   */
  async upsertActivityDay(input: ActivityDayInput): Promise<ActivityDay> {
    assertDate(input.logDate, 'activity date');
    assertNonNegativeInt(input.steps, 'Steps');
    assertNonNegativeInt(input.activeMinutes, 'Active minutes');

    let activeKcal: number;
    let kcalSource: ActivityCaloriesSource;
    if (input.activeKcal != null) {
      assertNonNegative(input.activeKcal, 'Active calories');
      activeKcal = Math.round(input.activeKcal);
      kcalSource = 'manual';
    } else {
      const { weightKg, heightCm } = await this.metricsAt(input.logDate);
      if (weightKg == null || heightCm == null) {
        throw new ValidationError(
          'Cannot estimate calories from steps — add your height and weight in the Health tab, or enter active calories yourself',
        );
      }
      const profile = await this.getProfile();
      activeKcal = estimateStepsCalories({
        steps: input.steps,
        weightKg,
        heightCm,
        sex: profile?.sex ?? null,
      });
      kcalSource = 'steps-estimate';
    }

    const existing = await this.getActivityDay(input.logDate);
    const now = new Date().toISOString();
    const day: ActivityDay = {
      id: existing?.id ?? uuid(),
      logDate: input.logDate,
      steps: input.steps,
      activeKcal,
      kcalSource,
      activeMinutes: input.activeMinutes,
      source: 'manual',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.writeAndQueue('activity_days', day);
    return day;
  }

  async deleteActivityDay(id: string): Promise<void> {
    await this.loadActivityDay(id);
    await this.tombstoneAndQueue('activity_days', id);
  }

  private async loadWorkout(id: string): Promise<Workout> {
    const workout = await this.db.get<Workout>('workouts', id);
    if (!workout) throw new NotFoundError(`Workout ${id} not found`);
    if (workout.deletedAt) throw new NotFoundError(`Workout ${id} not found`);
    return workout;
  }

  /** Workouts within [from, to] (inclusive), newest date first. */
  async getWorkouts(from?: string, to?: string): Promise<Workout[]> {
    if (from) assertDate(from, 'from date');
    if (to) assertDate(to, 'to date');
    const rows = await this.liveWorkouts(from, to);
    rows.sort((a, b) =>
      a.logDate === b.logDate ? (a.createdAt < b.createdAt ? 1 : -1) : a.logDate < b.logDate ? 1 : -1,
    );
    return rows;
  }

  /**
   * Calories (and the source that produced them) for a workout, resolved from
   * the stored profile and the latest weight at or before the workout date.
   * Snapshotted on the row so later profile/weight changes never rewrite it.
   */
  private async workoutEnergy(
    input: WorkoutInput,
  ): Promise<{ calories: number; caloriesSource: WorkoutCaloriesSource }> {
    const profile = await this.getProfile();
    const measurement = await this.getLatestHealthBefore(input.logDate);
    const energy = estimateWorkoutCalories({
      workoutType: input.workoutType,
      durationMin: input.durationMin,
      avgHr: input.avgHr,
      weightKg: measurement?.weightKg ?? null,
      age: resolveAge(profile?.birthYear ?? null, input.logDate),
      sex: profile?.sex ?? null,
      manualCalories: input.manualCalories,
    });
    return { calories: energy.calories, caloriesSource: energy.source };
  }

  /** The user-editable workout fields, normalized (shared by add and update). */
  private static workoutFields(input: WorkoutInput) {
    return {
      logDate: input.logDate,
      workoutType: input.workoutType.trim(),
      durationMin: roundTo(input.durationMin, 1),
      avgHr: input.avgHr,
      peakHr: input.peakHr,
      notes: input.notes?.trim() ? input.notes.trim() : null,
    };
  }

  async addWorkout(input: WorkoutInput): Promise<Workout> {
    assertWorkoutInput(input);
    const { calories, caloriesSource } = await this.workoutEnergy(input);
    const now = new Date().toISOString();
    const workout: Workout = {
      id: uuid(),
      ...Repository.workoutFields(input),
      calories,
      caloriesSource,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.writeAndQueue('workouts', workout);
    return workout;
  }

  /** Replace the editable fields; the calorie value is recomputed from scratch. */
  async updateWorkout(id: string, patch: WorkoutInput): Promise<Workout> {
    const existing = await this.loadWorkout(id);
    assertWorkoutInput(patch);
    const { calories, caloriesSource } = await this.workoutEnergy(patch);
    const updated: Workout = {
      ...existing,
      ...Repository.workoutFields(patch),
      calories,
      caloriesSource,
      updatedAt: new Date().toISOString(),
    };
    await this.writeAndQueue('workouts', updated);
    return updated;
  }

  async deleteWorkout(id: string): Promise<void> {
    await this.loadWorkout(id);
    await this.tombstoneAndQueue('workouts', id);
  }

  /**
   * The single profile row (sex + birth year) that powers HR-based estimates,
   * or null when the user has never saved one.
   */
  async getProfile(): Promise<UserProfile | null> {
    const profile = await this.db.get<UserProfile>('user_profile', PROFILE_ID);
    if (!profile) return null;
    return profile.deletedAt ? null : profile;
  }

  /** Upsert the profile row. Either field may be null (not disclosed). */
  async saveProfile(input: ProfileInput): Promise<UserProfile> {
    if (input.sex != null && input.sex !== 'male' && input.sex !== 'female') {
      throw new ValidationError(`Sex must be "male", "female", or null (got ${String(input.sex)})`);
    }
    if (input.birthYear != null) {
      const thisYear = new Date().getFullYear();
      if (!Number.isInteger(input.birthYear) || input.birthYear < 1900 || input.birthYear > thisYear) {
        throw new ValidationError(
          `Birth year must be a whole year between 1900 and ${thisYear} (got ${input.birthYear})`,
        );
      }
    }
    const existing = await this.getProfile();
    const now = new Date().toISOString();
    const profile: UserProfile = {
      id: PROFILE_ID,
      sex: input.sex,
      birthYear: input.birthYear,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.writeAndQueue('user_profile', profile);
    return profile;
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
    const rows = await this.db.query<SavedRecipe>('saved_recipes', {
      filter: (r) => {
        if (r.deletedAt) return false;
        if (q === '') return true;
        return (
          r.name.toLowerCase().includes(q) || r.aliases.some((a) => a.toLowerCase().includes(q))
        );
      },
    });
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
    await this.writeAndQueue('saved_recipes', recipe);
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
    const entries = await this.db.query<DailyEntry>('daily_entries', {
      index: 'logDate',
      lower: from,
      upper: to,
      filter: (r) => !r.deletedAt,
    });
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

    const entries = await this.db.query<DailyEntry>('daily_entries', {
      index: 'logDate',
      lower: from,
      upper: to,
      filter: (r) => !r.deletedAt,
    });

    const allMeasurements = await this.db.query<HealthMeasurement>('health_measurements', {
      index: 'measuredAt',
      upper: to,
      filter: (r) => !r.deletedAt,
    });
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

  /**
   * Intake (live food entries) vs. burn (resting baseline + live activity days +
   * live workouts) over a day / ISO week / calendar month. Net is intake − burn;
   * a range with no rows reports zeros rather than failing.
   *
   * The resting baseline is counted for every day of the range, including days
   * the user never logged — the body burns it either way. That is why it is
   * summed from `restingByDate` and not from the daily rows, which only cover
   * days with something logged.
   */
  async getEnergySummary(range: SummaryRange, anchorDate: string): Promise<EnergySummary> {
    assertDate(anchorDate, 'anchor date');
    const { from, to } = rangeBounds(range, anchorDate);
    const resting = await this.restingByDate(from, to);
    const daily = await this.dailyEnergyRows(from, to, resting);

    let intakeCalories = 0;
    let activeCalories = 0;
    for (const day of daily) {
      intakeCalories += day.intakeCalories;
      activeCalories += day.activeCalories;
    }
    let restingCalories: number | null = null;
    for (const value of resting.values()) {
      if (value == null) continue;
      restingCalories = (restingCalories ?? 0) + value;
    }
    const burnCalories = activeCalories + (restingCalories ?? 0);
    const workoutCount = (await this.liveWorkouts(from, to)).length;
    return {
      range,
      from,
      to,
      intakeCalories,
      restingCalories,
      burnCalories,
      netCalories: netEnergy(intakeCalories, burnCalories).net,
      workoutCount,
    };
  }

  /**
   * One row per date in [from, to] that has logged intake or burn (entries,
   * activity or workouts). Dates with nothing logged are absent so charts render
   * gaps instead of a zero line — same convention as getDailySummaries. The
   * resting baseline alone never creates a row, or every unlogged day in the
   * range would plot as a zero-intake day.
   */
  async getDailyEnergy(from: string, to: string): Promise<DailyEnergy[]> {
    assertDate(from, 'from date');
    assertDate(to, 'to date');
    if (from > to) throw new ValidationError('from date must be <= to date');
    return this.dailyEnergyRows(from, to, await this.restingByDate(from, to));
  }

  private async dailyEnergyRows(
    from: string,
    to: string,
    resting: Map<string, number | null>,
  ): Promise<DailyEnergy[]> {
    const intakeByDate = new Map<string, number>();
    for (const entry of await this.liveEntries(from, to)) {
      intakeByDate.set(entry.logDate, (intakeByDate.get(entry.logDate) ?? 0) + entry.calories);
    }
    const activeByDate = new Map<string, number>();
    for (const day of await this.liveActivityDays(from, to)) {
      activeByDate.set(day.logDate, (activeByDate.get(day.logDate) ?? 0) + day.activeKcal);
    }
    for (const workout of await this.liveWorkouts(from, to)) {
      activeByDate.set(workout.logDate, (activeByDate.get(workout.logDate) ?? 0) + workout.calories);
    }

    const out: DailyEnergy[] = [];
    for (let d = from; d <= to; d = nextDateKey(d)) {
      const intakeCalories = intakeByDate.get(d) ?? 0;
      const activeCalories = activeByDate.get(d) ?? 0;
      if (intakeCalories === 0 && activeCalories === 0) continue;
      const restingCalories = resting.get(d) ?? null;
      const burnCalories = activeCalories + (restingCalories ?? 0);
      out.push({
        logDate: d,
        intakeCalories,
        activeCalories,
        restingCalories,
        burnCalories,
        netCalories: netEnergy(intakeCalories, burnCalories).net,
      });
    }
    return out;
  }

  /**
   * Basal (resting) burn for every day in [from, to], null where the profile and
   * the measurements cannot supply weight, height and age.
   *
   * Weight and height are tracked independently: one measurement row may carry
   * only one of them, and each stays in force until a newer row replaces it. The
   * walk relies on the ascending `measuredAt` order both storage adapters return,
   * the same assumption `getDailySummaries` makes.
   */
  private async restingByDate(from: string, to: string): Promise<Map<string, number | null>> {
    const profile = await this.getProfile();
    const metrics = this.metricsByDate(from, to, await this.measurementsUpTo(to));
    const birthYear = profile?.birthYear ?? null;
    const sex = profile?.sex ?? null;

    const out = new Map<string, number | null>();
    for (const [d, m] of metrics) {
      const age = resolveAge(birthYear, d);
      out.set(
        d,
        m.weightKg != null && m.heightCm != null && age != null
          ? basalMetabolicRate({ weightKg: m.weightKg, heightCm: m.heightCm, age, sex })
          : null,
      );
    }
    return out;
  }

  /** Measurements up to and including `date`, ascending by measurement date. */
  private async measurementsUpTo(date: string): Promise<HealthMeasurement[]> {
    return this.db.query<HealthMeasurement>('health_measurements', {
      index: 'measuredAt',
      upper: date,
      filter: (r) => !r.deletedAt,
    });
  }

  /**
   * Weight and height in force on each day of [from, to], walked from ascending
   * measurement rows. The two are tracked independently — one row may carry only
   * one of them — and each stays in force until a newer row replaces it.
   */
  private metricsByDate(from: string, to: string, rows: HealthMeasurement[]): Map<string, BodyMetrics> {
    const out = new Map<string, BodyMetrics>();
    let weightKg: number | null = null;
    let heightCm: number | null = null;
    let i = 0;
    for (let d = from; d <= to; d = nextDateKey(d)) {
      while (i < rows.length && rows[i]!.measuredAt <= d) {
        const m = rows[i]!;
        // A weight-only row must not clear a height recorded earlier.
        weightKg = m.weightKg ?? weightKg;
        heightCm = m.heightCm ?? heightCm;
        i += 1;
      }
      out.set(d, { weightKg, heightCm });
    }
    return out;
  }

  /** Weight and height in force on a single date. */
  private async metricsAt(date: string): Promise<BodyMetrics> {
    const rows = await this.measurementsUpTo(date);
    return this.metricsByDate(date, date, rows).get(date) ?? { weightKg: null, heightCm: null };
  }

  /* ------------------------------------------------------------------ */
  /* sync                                                                */
  /* ------------------------------------------------------------------ */

  async getUnsyncedChanges(): Promise<SyncRecord[]> {
    const rows = await this.db.query<SyncRecord>('sync_queue', {
      filter: (r) => r.pushedAt == null,
    });
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
  async listForSync<T = Row>(table: SyncTable): Promise<T[]> {
    return this.db.query<T>(table);
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
    return this.db.get<CatalogMetadata>('catalog_metadata', CATALOG_VERSION_KEY);
  }

  /* ------------------------------------------------------------------ */
  /* backup export / import                                              */
  /* ------------------------------------------------------------------ */

  /** JSON backup of all user data (live rows only; tombstones excluded). */
  async exportBackup(): Promise<BackupPayload> {
    const userFoods = await this.getUserFoods();
    const entries = (await this.listForSync<DailyEntry>('daily_entries')).filter((r) => !r.deletedAt);
    const measurements = (await this.listForSync<HealthMeasurement>('health_measurements')).filter(
      (r) => !r.deletedAt,
    );
    const activityDays = (await this.listForSync<ActivityDay>('activity_days')).filter(
      (r) => !r.deletedAt,
    );
    const workouts = (await this.listForSync<Workout>('workouts')).filter((r) => !r.deletedAt);
    return {
      app: 'calorie-counter',
      version: 3,
      exportedAt: new Date().toISOString(),
      userFoods,
      entries,
      measurements,
      activityDays,
      workouts,
      profile: await this.getProfile(),
    };
  }

  /**
   * Import a backup. `restore: false` merges by UUID (newest updatedAt wins,
   * existing rows are kept); `restore: true` first clears all user data
   * (user foods, entries, measurements, activity, workouts, profile, sync
   * queue — never catalog rows), then inserts the backup. Imported rows are
   * queued for sync. Version 1 and 2 backups stay importable: the activity,
   * workout and profile sections they lack are treated as empty.
   */
  async importBackup(
    payload: unknown,
    opts: { restore: boolean },
  ): Promise<{
    userFoods: number;
    entries: number;
    measurements: number;
    activityDays: number;
    workouts: number;
    profile: number;
  }> {
    const data = payload as {
      version?: unknown;
      app?: unknown;
      userFoods?: unknown[];
      entries?: unknown[];
      measurements?: unknown[];
      activityDays?: unknown[];
      workouts?: unknown[];
      profile?: unknown;
    };
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
    if (data.version !== 1 && data.version !== 2 && data.version !== 3) {
      throw new ValidationError(`Unsupported backup version ${String(data.version)}`);
    }
    // Untrusted payloads: these arrays are narrowed, not trusted — the per-row
    // loops below reject anything that is not the expected row shape before a
    // single row reaches storage.
    const foods = data.userFoods as Food[];
    const entries = data.entries as DailyEntry[];
    const measurements = data.measurements as HealthMeasurement[];
    const activityDays = (Array.isArray(data.activityDays) ? data.activityDays : []) as ActivityDay[];
    const workouts = (Array.isArray(data.workouts) ? data.workouts : []) as Workout[];
    // Absent profile keeps its null-versus-object behavior.
    const profile =
      data.profile && typeof data.profile === 'object' ? (data.profile as UserProfile) : null;
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
    for (const a of activityDays) {
      if (typeof a.id !== 'string' || typeof a.updatedAt !== 'string' || typeof a.logDate !== 'string') {
        throw new ValidationError('Backup contains an invalid activity day');
      }
    }
    for (const w of workouts) {
      if (typeof w.id !== 'string' || typeof w.updatedAt !== 'string' || typeof w.logDate !== 'string') {
        throw new ValidationError('Backup contains an invalid workout');
      }
    }
    if (profile && (typeof profile.updatedAt !== 'string' || profile.id !== PROFILE_ID)) {
      throw new ValidationError('Backup contains an invalid profile');
    }

    if (opts.restore) {
      const userFoods = await this.getUserFoods();
      for (const f of userFoods) await this.db.remove('foods', f.id);
      await this.db.clear('daily_entries');
      await this.db.clear('health_measurements');
      await this.db.clear('activity_days');
      await this.db.clear('workouts');
      await this.db.clear('user_profile');
      await this.db.clear('sync_queue');
    }

    const merged = async <T extends { id: string; updatedAt: string }>(table: SyncTable, rows: T[]) => {
      let applied = 0;
      for (const row of rows) {
        const local = await this.db.get(table, row.id);
        if (local && String(local.updatedAt) > row.updatedAt) continue;
        await this.writeAndQueue(table, row);
        applied++;
      }
      return applied;
    };

    return {
      userFoods: await merged<Food>('foods', foods),
      entries: await merged<DailyEntry>('daily_entries', entries),
      measurements: await merged<HealthMeasurement>('health_measurements', measurements),
      activityDays: await merged<ActivityDay>('activity_days', activityDays),
      workouts: await merged<Workout>('workouts', workouts),
      profile: await merged<UserProfile>('user_profile', profile ? [profile] : []),
    };
  }

  /* ------------------------------------------------------------------ */
  /* internals                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Live (non-tombstoned) rows of one table within [from, to] by date index.
   * The callers sort; these stay unsorted so each aggregation reads once.
   */
  private async liveEntries(from?: string, to?: string): Promise<DailyEntry[]> {
    return this.db.query<DailyEntry>('daily_entries', {
      index: 'logDate',
      lower: from ?? undefined,
      upper: to ?? undefined,
      filter: (r) => !r.deletedAt,
    });
  }

  private async liveActivityDays(from?: string, to?: string): Promise<ActivityDay[]> {
    return this.db.query<ActivityDay>('activity_days', {
      index: 'logDate',
      lower: from ?? undefined,
      upper: to ?? undefined,
      filter: (r) => !r.deletedAt,
    });
  }

  private async liveWorkouts(from?: string, to?: string): Promise<Workout[]> {
    return this.db.query<Workout>('workouts', {
      index: 'logDate',
      lower: from ?? undefined,
      upper: to ?? undefined,
      filter: (r) => !r.deletedAt,
    });
  }

  private async writeAndQueue<T extends { id: unknown; updatedAt: unknown }>(
    table: SyncTable,
    row: T,
  ): Promise<void> {
    await this.db.put(table, row);
    const record: SyncRecord = {
      id: String(row.id),
      table,
      op: 'upsert',
      updatedAt: String(row.updatedAt),
      pushedAt: null,
      error: null,
    };
    await this.db.put('sync_queue', record);
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
    await this.db.put('sync_queue', record);
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
