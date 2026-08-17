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
import { isValidDateKey, todayKey } from '@/domain/dates';
import type {
  CatalogMetadata,
  DailyEntry,
  DailySummary,
  Food,
  HealthMeasurement,
  Serving,
  SyncRecord,
  SyncTable,
  UserFood,
} from '@/domain/types';
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
  servings: Serving[];
}

export interface MeasurementInput {
  measuredAt: string;
  weightKg: number | null;
  heightCm: number | null;
}

export interface BackupPayload {
  app: 'calorie-counter';
  version: 1;
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
    const now = new Date().toISOString();
    const entry: DailyEntry = {
      id: uuid(),
      logDate: input.logDate,
      foodId: food.id,
      foodName: food.name,
      caloriesPer100g: food.caloriesPer100g,
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
    const updated: DailyEntry = {
      ...entry,
      servingId: serving.id,
      servingLabel: serving.label,
      servingGrams: serving.grams,
      amount,
      grams,
      calories,
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
  /* summaries                                                           */
  /* ------------------------------------------------------------------ */

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

    const byDate = new Map<string, { calories: number; entryCount: number }>();
    for (const e of entries) {
      const agg = byDate.get(e.logDate) ?? { calories: 0, entryCount: 0 };
      agg.calories += e.calories;
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
      version: 1,
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
    const data = payload as Partial<BackupPayload>;
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
    const foods = data.userFoods as unknown as Food[];
    const entries = data.entries as unknown as DailyEntry[];
    const measurements = data.measurements as unknown as HealthMeasurement[];
    for (const f of foods) {
      if (typeof f.id !== 'string' || typeof f.updatedAt !== 'string' || f.source !== 'user') {
        throw new ValidationError('Backup contains an invalid user food');
      }
    }
    for (const e of entries) {
      if (typeof e.id !== 'string' || typeof e.updatedAt !== 'string' || typeof e.logDate !== 'string') {
        throw new ValidationError('Backup contains an invalid daily entry');
      }
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
