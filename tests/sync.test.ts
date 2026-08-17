/**
 * Sync engine behavior against a fake Supabase transport: push idempotency,
 * newest-updatedAt-wins pulls, tombstone propagation, cursor persistence,
 * offline failure queuing, and the "not configured" contract.
 */
import { IndexedDbStorage } from '@/db/indexeddb';
import { Repository } from '@/db/repository';
import { TABLES } from '@/db/schema';
import type { CatalogBundle } from '@/db/seedCatalog';
import type { Row } from '@/db/storage';
import { SyncEngine, SyncNotConfiguredError, type SyncStatus } from '@/sync/syncEngine';
import { beforeEach, describe, expect, it } from 'vitest';
import bundle from '../data/foods.json';

type RemoteRow = Record<string, unknown>;

interface FakeSupabaseClient {
  auth: {
    getSession(): Promise<{ data: { session: { user: { id: string; email: string } } | null }; error: null }>;
    onAuthStateChange(cb: (event: string) => void): () => void;
    signInWithPassword(): Promise<{ error: null }>;
    signUp(): Promise<{ error: null }>;
    signOut(): Promise<{ error: null }>;
  };
  __failNext(): void;
  from(table: string): {
    upsert(rows: RemoteRow | RemoteRow[], opts?: unknown): Promise<{ error: { message: string } | null }>;
    select(): {
      order(col: string, o: unknown): {
        gt(col: string, val: string): Promise<{ data: RemoteRow[]; error: null }>;
      };
    };
  };
}

interface RemoteTables {
  user_foods: RemoteRow[];
  daily_entries: RemoteRow[];
  health_measurements: RemoteRow[];
  saved_recipes: RemoteRow[];
}

interface FakeClientOptions {
  remote: Record<string, RemoteRow[]>;
  session: { user: { id: string; email: string } } | null;
  failNextUpsert?: () => boolean;
}

function makeFakeClient(opts: FakeClientOptions): FakeSupabaseClient {
  let fail = false;
  const auth = {
    getSession: async () => ({ data: { session: opts.session }, error: null }),
    onAuthStateChange: () => () => {},
    signInWithPassword: async () => ({ error: null }),
    signUp: async () => ({ error: null }),
    signOut: async () => ({ error: null }),
  };
  return {
    auth,
    __failNext: () => {
      fail = true;
    },
    from: (table: string) => ({
      upsert: async (rows: RemoteRow[], _o?: unknown) => {
        if (fail) {
          fail = false;
          return { error: { message: 'offline (fake)' } };
        }
        const store = opts.remote[table] ?? (opts.remote[table] = []);
        for (const row of Array.isArray(rows) ? rows : [rows]) {
          const i = store.findIndex((r) => r.id === row.id);
          if (i >= 0) store[i] = { ...store[i]!, ...row };
          else store.push(row);
        }
        return { error: null };
      },
      select: () => ({
        order: (_col: string, _o: unknown) => {
          // mimic supabase-js: the query builder is thenable (awaitable),
          // and .gt() narrows it to rows newer than the cursor
          const all = () => Promise.resolve({ data: [...(opts.remote[table] ?? [])], error: null });
          const newer = (val: string) => {
            const store = [...(opts.remote[table] ?? [])]
              .filter((r) => String(r.updated_at) > val)
              .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
            return Promise.resolve({ data: store, error: null });
          };
          return {
            gt: (col: string, val: string) => newer(val),
            then: (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) => all().then(onF, onR),
          };
        },
      }),
    }),
  };
}

async function makeEnv(opts?: Partial<FakeClientOptions>) {
  const repo = new Repository(new IndexedDbStorage());
  await repo.init();
  await repo.ensureCatalog(bundle as unknown as CatalogBundle);
  const remote: RemoteTables = {
    user_foods: [],
    daily_entries: [],
    health_measurements: [],
    saved_recipes: [],
  };
  const client = makeFakeClient({
    remote: remote as unknown as Record<string, RemoteRow[]>,
    session: { user: { id: 'user-1', email: 'me@example.com' } },
    ...opts,
  });
  const engine = new SyncEngine(repo, () => client as never);
  await engine.initialize();
  return { repo, engine, client, remote };
}

async function wipe(): Promise<void> {
  const storage = new IndexedDbStorage();
  await storage.init();
  for (const t of Object.keys(TABLES)) await storage.clear(t);
}

beforeEach(async () => {
  await wipe();
});

async function addBroccoliEntry(repo: Repository, logDate = '2026-08-17', amount = 1) {
  const foods = await repo.searchFoods('Broccoli', 1);
  return repo.addEntry({ logDate, foodId: foods[0]!.id, servingId: 'sv-cup', amount });
}

describe('SyncEngine', () => {
  it('reports not-configured and never discards queued changes', async () => {
    const repo = new Repository(new IndexedDbStorage());
    await repo.init();
    await repo.ensureCatalog(bundle as unknown as CatalogBundle);
    const engine = new SyncEngine(repo, () => null);
    await engine.initialize();
    expect(engine.getStatus()).toBe('not-configured');

    await addBroccoliEntry(repo);
    await expect(engine.sync()).rejects.toBeInstanceOf(SyncNotConfiguredError);
    expect((await repo.getUnsyncedChanges()).length).toBe(1); // still queued
    expect((await repo.getDailyEntries('2026-08-17')).length).toBe(1); // still local
  });

  it('pushes queued changes and marks them synced only after confirmation', async () => {
    const { repo, engine, remote } = await makeEnv();
    const e = await addBroccoliEntry(repo);
    await engine.sync();
    expect(remote.daily_entries.length).toBe(1);
    expect(remote.daily_entries[0]).toMatchObject({ id: e.id, user_id: 'user-1', log_date: '2026-08-17' });
    expect(await repo.getUnsyncedChanges()).toEqual([]);
    expect(engine.getStatus()).toBe('synced');
  });

  it('push is idempotent (same UUIDs overwrite, no duplicates)', async () => {
    const { repo, engine, remote } = await makeEnv();
    await addBroccoliEntry(repo);
    await engine.sync();
    await engine.sync();
    expect(remote.daily_entries.length).toBe(1);
  });

  it('pushes tombstones so deletes propagate', async () => {
    const { repo, engine, remote } = await makeEnv();
    const e = await addBroccoliEntry(repo);
    await repo.deleteEntry(e.id);
    await engine.sync();
    expect(remote.daily_entries.length).toBe(1);
    expect(remote.daily_entries[0]!.deleted_at).not.toBeNull();
    expect(await repo.getUnsyncedChanges()).toEqual([]);
  });

  it('pulls remote rows newer than the cursor and applies newest-wins', async () => {
    const { repo, engine, remote } = await makeEnv();
    const e = await addBroccoliEntry(repo);
    await engine.sync(); // push local, cursor set
    // a second device edits the same row more recently
    const newer = remote.daily_entries[0]!;
    remote.daily_entries = [{ ...newer, amount: 5, calories: 777, updated_at: '2099-01-01T00:00:00.000Z' }];
    const result = await engine.sync();
    expect(result.pulled).toBe(1);
    expect(result.applied).toBe(1);
    const local = await repo.getDailyEntries('2026-08-17');
    expect(local[0]!.calories).toBe(777);
    expect(local[0]!.amount).toBe(5);
    // cursor persisted → nothing re-pulled next time
    expect((await engine.sync()).pulled).toBe(0);
  });

  it('propagates remote tombstones to local via pull', async () => {
    const { repo, engine, remote } = await makeEnv();
    const e = await addBroccoliEntry(repo);
    await engine.sync(); // push local first
    const row = remote.daily_entries[0]!;
    remote.daily_entries = [{ ...row, deleted_at: '2099-01-01T00:00:00.000Z', updated_at: '2099-01-01T00:00:00.000Z' }];
    await engine.sync();
    expect(await repo.getDailyEntries('2026-08-17')).toEqual([]);
  });

  it('keeps offline failures queued and surfaces them without blocking local logging', async () => {
    const { repo, engine, client, remote } = await makeEnv();
    await addBroccoliEntry(repo);
    client.__failNext();
    const result = await engine.sync();
    expect(result.pushed).toBe(0);
    // offline failures stay queued and are shown as "Not synced yet" (pending), never lost
    expect(engine.getStatus()).toBe('pending');
    expect(engine.getLastError()).toContain('offline');
    const queue = await repo.getUnsyncedChanges();
    expect(queue.length).toBe(1);
    expect(queue[0]!.error).toContain('offline');
    // local data still usable
    expect((await repo.getDailyEntries('2026-08-17')).length).toBe(1);
    expect(remote.daily_entries.length).toBe(0); // nothing reached the server

    // retry succeeds and clears the queue
    await engine.sync();
    expect(remote.daily_entries.length).toBe(1);
    expect(await repo.getUnsyncedChanges()).toEqual([]);
    expect(engine.getStatus()).toBe('synced');
  });

  it('exposes auth-aware status and email', async () => {
    const { engine } = await makeEnv();
    expect(await engine.getUserEmail()).toBe('me@example.com');
    const noSession = new SyncEngine(new Repository(new IndexedDbStorage()), () =>
      makeFakeClient({ remote: {}, session: null }) as never,
    );
    await noSession.initialize();
    expect(noSession.getStatus()).toBe('signed-out');
    expect(await noSession.getUserEmail()).toBeNull();
    await noSession.sync();
    expect(noSession.getStatus()).toBe('signed-out');
  });

  it('signals pending when local changes exist after a successful sync', async () => {
    const { repo, engine } = await makeEnv();
    await engine.sync(); // nothing yet → synced
    await addBroccoliEntry(repo);
    expect(await engine.hasPendingChanges()).toBe(true);
    let observed: SyncStatus | null = null;
    engine.subscribe((s) => {
      observed = s;
    });
    await engine.sync();
    expect(observed).toBe('synced');
    expect(await engine.hasPendingChanges()).toBe(false);
  });

  it('syncs user foods and measurements as well as entries', async () => {
    const { repo, engine, remote } = await makeEnv();
    const food = await repo.createUserFood(
      { name: 'Test Fuel', caloriesPer100g: 200, proteinPer100g: 10, carbsPer100g: 30, fatPer100g: 5, servings: [{ id: 'g', label: 'g', grams: 1, approx: false }] },
      'user-1',
    );
    const m = await repo.addHealthMeasurement({ measuredAt: '2026-08-17', weightKg: 70.5, heightCm: null });
    await engine.sync();
    expect(remote.user_foods.length).toBe(1);
    expect(remote.user_foods[0]!).toMatchObject({ id: food.id, name: 'Test Fuel' });
    expect(remote.health_measurements.length).toBe(1);
    expect(remote.health_measurements[0]!).toMatchObject({ id: m.id, weight_kg: 70.5 });
  });

  it('round-trips macros on foods and entries in both directions', async () => {
    const { repo, engine, remote } = await makeEnv();
    const food = await repo.createUserFood(
      { name: 'Macro Fuel', caloriesPer100g: 220, proteinPer100g: 15.5, carbsPer100g: 30.2, fatPer100g: 4.8, servings: [{ id: 'g', label: 'g', grams: 1, approx: false }] },
      'user-1',
    );
    const entry = await repo.addEntry({ logDate: '2026-08-17', foodId: food.id, servingId: 'g', amount: 100 });
    expect(entry.proteinGrams).not.toBeNull();
    await engine.sync();

    // push: snake_case macro columns with the local values
    expect(remote.user_foods[0]!).toMatchObject({
      protein_per_100g: 15.5,
      carbs_per_100g: 30.2,
      fat_per_100g: 4.8,
    });
    expect(remote.daily_entries[0]!).toMatchObject({
      protein_grams: entry.proteinGrams,
      carbs_grams: entry.carbsGrams,
      fat_grams: entry.fatGrams,
    });

    // pull: a remote edit with macros applies into the local camelCase shape
    const remoteEntry = { ...remote.daily_entries[0]! };
    remoteEntry.protein_grams = 99.9;
    remoteEntry.updated_at = '2099-01-01T00:00:00.000Z';
    remote.daily_entries[0] = remoteEntry;
    await engine.sync();
    const local = await repo.getDailyEntries('2026-08-17');
    expect(local[0]!.proteinGrams).toBe(99.9);

    // legacy rows without macro columns come back as null, never undefined
    const legacyRemote = { ...remote.daily_entries[0]! };
    delete legacyRemote.protein_grams;
    delete legacyRemote.carbs_grams;
    delete legacyRemote.fat_grams;
    legacyRemote.updated_at = '2099-02-01T00:00:00.000Z';
    remote.daily_entries[0] = legacyRemote;
    await engine.sync();
    const legacyLocal = await repo.getDailyEntries('2026-08-17');
    expect(legacyLocal[0]!.proteinGrams).toBeNull();
    expect(legacyLocal[0]!.carbsGrams).toBeNull();
    expect(legacyLocal[0]!.fatGrams).toBeNull();
  });

  it('syncs saved recipes (consent-gated memory) in both directions', async () => {
    const { repo, engine, remote } = await makeEnv();
    const peppers = await repo.searchFoods('Pepper, bell, green', 1);
    const recipe = await repo.saveRecipe({
      name: 'lecsó',
      ingredients: [{ raw: 'green peppers', foodQuery: 'Pepper, bell, green', amount: 3, servingLabel: 'piece' }],
      foodIds: [peppers[0]!.id],
      servingGrams: 250,
      aliases: ['lecsó', 'hungarian pepper stew'],
    });
    await engine.sync();
    expect(remote.saved_recipes.length).toBe(1);
    expect(remote.saved_recipes[0]!).toMatchObject({
      name: 'lecsó',
      serving_grams: 250,
      aliases: ['lecsó', 'hungarian pepper stew'],
    });

    // pull a remote recipe back into a fresh repo
    const { repo: repo2, engine: engine2 } = await makeEnv();
    await engine2.sync(); // pulls the recipe already on the fake remote
    const found = await repo2.searchRecipes('pepper stew');
    expect(found.map((r) => r.name)).toEqual(['lecsó']);
    expect(found[0]!.foodIds).toEqual([peppers[0]!.id]);
  });
});
