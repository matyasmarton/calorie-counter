/**
 * Sync engine — authentication-aware push/pull against Supabase.
 *
 * Contract:
 *  - push: queue rows are sent idempotently (same UUID primary keys); a row
 *    is marked synced only after the server confirms.
 *  - pull: remote rows newer than the per-table cursor are applied with
 *    newest-updatedAt-wins; tombstones (deletedAt) propagate deletions.
 *  - offline failures keep their queue rows and never block local logging.
 *  - missing configuration throws SyncNotConfiguredError — local data is
 *    still fully usable.
 */
import type { Repository } from '@/db/repository';
import type { Row } from '@/db/storage';
import type { SyncTable } from '@/domain/types';
import type { SupabaseClient } from '@supabase/supabase-js';

export class SyncNotConfiguredError extends Error {
  constructor() {
    super('Sync not configured');
    this.name = 'SyncNotConfiguredError';
  }
}

export type SyncStatus =
  | 'not-configured'
  | 'signed-out'
  | 'pending' // signed in with unsynced local changes
  | 'syncing'
  | 'synced'
  | 'error';

export interface SyncResult {
  pushed: number;
  pulled: number;
  applied: number;
}

const SYNC_TABLES: SyncTable[] = [
  'foods',
  'daily_entries',
  'health_measurements',
  'saved_recipes',
  'activity_days',
  'workouts',
  'user_profile',
];

const REMOTE_TABLE: Record<SyncTable, string> = {
  foods: 'user_foods',
  daily_entries: 'daily_entries',
  health_measurements: 'health_measurements',
  saved_recipes: 'saved_recipes',
  activity_days: 'activity_days',
  workouts: 'workouts',
  user_profile: 'user_profile',
};

/* ------------------------- row mapping (camel <-> snake) ------------------------- */

const foodRemote = (row: Row, userId: string) => ({
  id: row.id,
  user_id: userId,
  name: row.name,
  category: row.category,
  calories_per_100g: row.caloriesPer100g,
  protein_per_100g: row.proteinPer100g ?? null,
  carbs_per_100g: row.carbsPer100g ?? null,
  fat_per_100g: row.fatPer100g ?? null,
  servings: row.servings,
  source_ref: row.sourceRef,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
  deleted_at: row.deletedAt,
});

const foodLocal = (r: Record<string, unknown>): Row => ({
  id: r.id,
  name: r.name,
  category: r.category,
  caloriesPer100g: r.calories_per_100g,
  proteinPer100g: r.protein_per_100g ?? null,
  carbsPer100g: r.carbs_per_100g ?? null,
  fatPer100g: r.fat_per_100g ?? null,
  servings: r.servings,
  source: 'user',
  ownerId: r.user_id,
  sourceRef: r.source_ref,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});

const entryRemote = (row: Row, userId: string) => ({
  id: row.id,
  user_id: userId,
  log_date: row.logDate,
  food_id: row.foodId,
  food_name: row.foodName,
  calories_per_100g: row.caloriesPer100g,
  protein_grams: row.proteinGrams ?? null,
  carbs_grams: row.carbsGrams ?? null,
  fat_grams: row.fatGrams ?? null,
  serving_id: row.servingId,
  serving_label: row.servingLabel,
  serving_grams: row.servingGrams,
  amount: row.amount,
  grams: row.grams,
  calories: row.calories,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
  deleted_at: row.deletedAt,
});

const entryLocal = (r: Record<string, unknown>): Row => ({
  id: r.id,
  logDate: r.log_date,
  foodId: r.food_id,
  foodName: r.food_name,
  caloriesPer100g: r.calories_per_100g,
  proteinGrams: r.protein_grams ?? null,
  carbsGrams: r.carbs_grams ?? null,
  fatGrams: r.fat_grams ?? null,
  servingId: r.serving_id,
  servingLabel: r.serving_label,
  servingGrams: r.serving_grams,
  amount: r.amount,
  grams: r.grams,
  calories: r.calories,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});

const measurementRemote = (row: Row, userId: string) => ({
  id: row.id,
  user_id: userId,
  measured_at: row.measuredAt,
  weight_kg: row.weightKg,
  height_cm: row.heightCm,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
  deleted_at: row.deletedAt,
});

const measurementLocal = (r: Record<string, unknown>): Row => ({
  id: r.id,
  measuredAt: r.measured_at,
  weightKg: r.weight_kg,
  heightCm: r.height_cm,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});

const recipeRemote = (row: Row, userId: string) => ({
  id: row.id,
  user_id: userId,
  name: row.name,
  ingredients: row.ingredients,
  food_ids: row.foodIds,
  serving_grams: row.servingGrams,
  calories: row.calories,
  protein_grams: row.proteinGrams ?? null,
  carbs_grams: row.carbsGrams ?? null,
  fat_grams: row.fatGrams ?? null,
  aliases: row.aliases,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
  deleted_at: row.deletedAt,
});

const recipeLocal = (r: Record<string, unknown>): Row => ({
  id: r.id,
  name: r.name,
  ingredients: r.ingredients,
  foodIds: r.food_ids,
  servingGrams: r.serving_grams,
  calories: r.calories ?? 0,
  proteinGrams: r.protein_grams ?? null,
  carbsGrams: r.carbs_grams ?? null,
  fatGrams: r.fat_grams ?? null,
  aliases: r.aliases ?? [],
  ownerId: r.user_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});

const activityRemote = (row: Row, userId: string) => ({
  id: row.id,
  user_id: userId,
  log_date: row.logDate,
  steps: row.steps,
  active_kcal: row.activeKcal,
  active_minutes: row.activeMinutes,
  source: row.source ?? 'manual',
  created_at: row.createdAt,
  updated_at: row.updatedAt,
  deleted_at: row.deletedAt,
});

const activityLocal = (r: Record<string, unknown>): Row => ({
  id: r.id,
  logDate: r.log_date,
  steps: r.steps ?? 0,
  activeKcal: r.active_kcal ?? 0,
  activeMinutes: r.active_minutes ?? 0,
  source: 'manual',
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});

const workoutRemote = (row: Row, userId: string) => ({
  id: row.id,
  user_id: userId,
  log_date: row.logDate,
  workout_type: row.workoutType,
  duration_min: row.durationMin,
  avg_hr: row.avgHr ?? null,
  peak_hr: row.peakHr ?? null,
  calories: row.calories,
  calories_source: row.caloriesSource,
  notes: row.notes ?? null,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
  deleted_at: row.deletedAt,
});

const workoutLocal = (r: Record<string, unknown>): Row => ({
  id: r.id,
  logDate: r.log_date,
  workoutType: r.workout_type,
  durationMin: r.duration_min,
  avgHr: r.avg_hr ?? null,
  peakHr: r.peak_hr ?? null,
  calories: r.calories ?? 0,
  caloriesSource: r.calories_source,
  notes: r.notes ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});

/* The profile row's id is the literal "profile" (one row per user), which is
   why the remote column is text rather than uuid — see 003_activity.sql. */
const profileRemote = (row: Row, userId: string) => ({
  id: row.id,
  user_id: userId,
  sex: row.sex ?? null,
  birth_year: row.birthYear ?? null,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
  deleted_at: row.deletedAt,
});

const profileLocal = (r: Record<string, unknown>): Row => ({
  id: r.id,
  sex: r.sex ?? null,
  birthYear: r.birth_year ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});

function toRemote(table: SyncTable, row: Row, userId: string): Record<string, unknown> {
  switch (table) {
    case 'foods':
      return foodRemote(row, userId);
    case 'daily_entries':
      return entryRemote(row, userId);
    case 'health_measurements':
      return measurementRemote(row, userId);
    case 'saved_recipes':
      return recipeRemote(row, userId);
    case 'activity_days':
      return activityRemote(row, userId);
    case 'workouts':
      return workoutRemote(row, userId);
    case 'user_profile':
      return profileRemote(row, userId);
  }
}

function toLocal(table: SyncTable, r: Record<string, unknown>): Row {
  switch (table) {
    case 'foods':
      return foodLocal(r);
    case 'daily_entries':
      return entryLocal(r);
    case 'health_measurements':
      return measurementLocal(r);
    case 'saved_recipes':
      return recipeLocal(r);
    case 'activity_days':
      return activityLocal(r);
    case 'workouts':
      return workoutLocal(r);
    case 'user_profile':
      return profileLocal(r);
  }
}

function cursorKey(table: SyncTable): string {
  return `cursor:${table}`;
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

/* --------------------------------- engine --------------------------------- */

export class SyncEngine {
  private status: SyncStatus = 'not-configured';
  private syncing = false;
  private lastError: string | null = null;
  private lastSyncedAt: string | null = null;
  private listeners = new Set<(s: SyncStatus) => void>();
  private unsubscribeAuth: (() => void) | null = null;

  constructor(
    private readonly repo: Repository,
    private readonly getClient: () => SupabaseClient | null,
  ) {}

  subscribe(cb: (s: SyncStatus) => void): () => void {
    this.listeners.add(cb);
    cb(this.status);
    return () => this.listeners.delete(cb);
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  async getLastSyncedAt(): Promise<string | null> {
    return this.repo.getSyncMeta('last_sync_at');
  }

  /** True when there are local changes not yet pushed. */
  async hasPendingChanges(): Promise<boolean> {
    return (await this.repo.getUnsyncedChanges()).length > 0;
  }

  private setStatus(s: SyncStatus): void {
    this.status = s;
    for (const cb of this.listeners) cb(s);
  }

  /** Called once at app start: detect config + session, wire auth events. */
  async initialize(): Promise<void> {
    const client = this.getClient();
    if (!client) {
      this.setStatus('not-configured');
      return;
    }
    const { data } = await client.auth.getSession();
    this.setStatus(data.session ? 'pending' : 'signed-out');
    const authSub = client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') {
        this.lastError = null;
        this.setStatus('pending');
      } else if (event === 'SIGNED_OUT') {
        this.setStatus('signed-out');
      }
    });
    this.unsubscribeAuth = () => authSub.data.subscription.unsubscribe();
  }

  async signIn(email: string, password: string): Promise<void> {
    const client = this.requireClient();
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
  }

  async signUp(email: string, password: string): Promise<void> {
    const client = this.requireClient();
    const { error } = await client.auth.signUp({ email, password });
    if (error) throw new Error(error.message);
  }

  async signOut(): Promise<void> {
    const client = this.getClient();
    if (client) {
      const { error } = await client.auth.signOut();
      if (error) throw new Error(error.message);
    }
  }

  /** Signed-in user's email, or null when signed out / not configured. */
  async getUserEmail(): Promise<string | null> {
    const client = this.getClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session?.user.email ?? null;
  }

  /** Push queued changes, then pull newer remote rows. */
  async sync(): Promise<SyncResult> {
    const client = this.requireClient();
    if (this.syncing) return { pushed: 0, pulled: 0, applied: 0 };
    this.syncing = true;
    this.setStatus('syncing');
    let pushed = 0;
    let pulled = 0;
    let applied = 0;
    try {
      const {
        data: { session },
      } = await client.auth.getSession();
      if (!session) {
        this.setStatus('signed-out');
        return { pushed, pulled, applied };
      }
      const userId = session.user.id;

      /* ---- push ---- */
      const queue = await this.repo.getUnsyncedChanges();
      const succeeded: string[] = [];
      let firstError: string | null = null;
      for (const rec of queue) {
        try {
          const row = await this.repo.getRow(rec.table, rec.id);
          if (!row) {
            succeeded.push(rec.id); // record physically gone; nothing to send
            continue;
          }
          const { error } = await client
            .from(REMOTE_TABLE[rec.table])
            .upsert(toRemote(rec.table, row, userId), { onConflict: 'id' });
          if (error) throw error;
          succeeded.push(rec.id);
          pushed++;
        } catch (e) {
          const msg = errMessage(e);
          if (!firstError) firstError = msg;
          await this.repo.setSyncError(rec.id, msg);
        }
      }
      if (succeeded.length > 0) await this.repo.markSynced(succeeded);

      /* ---- pull ---- */
      for (const table of SYNC_TABLES) {
        const cursor = await this.repo.getSyncMeta(cursorKey(table));
        let query = client
          .from(REMOTE_TABLE[table])
          .select('*')
          .order('updated_at', { ascending: true });
        if (cursor) query = query.gt('updated_at', cursor);
        const { data, error } = await query;
        if (error) throw error;
        const remote = (data ?? []) as Record<string, unknown>[];
        const appliedNow = await this.repo.applyRemote(table, remote.map((r) => toLocal(table, r)));
        pulled += remote.length;
        applied += appliedNow;
        if (remote.length > 0) {
          const last = remote[remote.length - 1]!;
          await this.repo.putSyncMeta(cursorKey(table), String(last.updated_at));
        }
      }

      this.lastSyncedAt = new Date().toISOString();
      await this.repo.putSyncMeta('last_sync_at', this.lastSyncedAt);
      if (firstError) {
        // offline/partial failures: stay queued, show "Not synced yet" with detail
        this.lastError = firstError;
        this.setStatus('pending');
      } else {
        this.lastError = null;
        this.setStatus(await this.hasPendingChanges() ? 'pending' : 'synced');
      }
      return { pushed, pulled, applied };
    } catch (e) {
      this.lastError = errMessage(e);
      this.setStatus('error');
      return { pushed, pulled, applied };
    } finally {
      this.syncing = false;
    }
  }

  private requireClient(): SupabaseClient {
    const client = this.getClient();
    if (!client) throw new SyncNotConfiguredError();
    return client;
  }
}
