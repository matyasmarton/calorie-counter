/**
 * verify-device-transfer.ts
 *
 * Answers one question in a runnable, reproducible way: when a user logs data
 * on one device, is it actually persisted — and does it actually arrive on a
 * second device?
 *
 * Two independent "devices" are simulated with separate IndexedDB factories
 * (fake-indexeddb), so a passing run cannot be an artefact of two Repository
 * instances accidentally sharing the same store. Each device is checked for:
 *
 *   1. persistence   — a fresh Repository over the same storage reads the data
 *                      back (i.e. an app restart loses nothing)
 *   2. isolation     — the second device starts genuinely empty
 *   3. backup path   — export on A → import on B (the Settings JSON transfer)
 *   4. sync path     — A pushes to a shared remote, B pulls (the Supabase path,
 *                      against an in-memory stand-in for the server)
 *   5. deletion      — a tombstone on A also removes the row on B
 *
 * What it deliberately does NOT prove is listed in the report footer: the real
 * Supabase backend, the Android SQLite adapter, and physical devices are not
 * exercised here.
 *
 * Run: npm run verify:transfer
 */
import { IndexedDbStorage } from '@/db/indexeddb';
import { Repository } from '@/db/repository';
import type { CatalogBundle } from '@/db/seedCatalog';
import type { DailyEntry, HealthMeasurement, UserFood, Workout } from '@/domain/types';
import { SyncEngine } from '@/sync/syncEngine';
import type { SupabaseClient } from '@supabase/supabase-js';
import { IDBFactory, IDBKeyRange as FakeIdbKeyRange } from 'fake-indexeddb';
import catalogBundle from '../data/foods.json';

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail: string): void {
  checks++;
  if (!ok) failures++;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ */
/* two isolated devices + one shared remote                            */
/* ------------------------------------------------------------------ */

const USER_ID = 'user-1';

/**
 * A stand-in Supabase backend: in-memory tables with the same
 * upsert / select-ordered / gt-cursor surface the sync engine uses.
 */
class FakeCloud {
  readonly tables = new Map<string, Row[]>();
  readonly session = { user: { id: USER_ID, email: 'verify@example.com' } };

  private table(name: string): Row[] {
    const existing = this.tables.get(name);
    if (existing) return existing;
    const fresh: Row[] = [];
    this.tables.set(name, fresh);
    return fresh;
  }

  toClient(): SupabaseClient {
    const client = {
      auth: {
        getSession: async () => ({ data: { session: this.session }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        signInWithPassword: async () => ({ error: null }),
        signUp: async () => ({ error: null }),
        signOut: async () => ({ error: null }),
      },
      from: (name: string) => ({
        upsert: async (rows: Row | Row[]) => {
          const store = this.table(name);
          for (const row of Array.isArray(rows) ? rows : [rows]) {
            const i = store.findIndex((r) => r.id === row.id);
            if (i >= 0) store[i] = { ...store[i], ...row };
            else store.push({ ...row });
          }
          return { error: null };
        },
        select: () => ({
          order: () => ({
            gt: async (_column: string, cursor: string) => ({
              data: [...this.table(name)]
                .filter((r) => String(r.updated_at) > cursor)
                .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at))),
              error: null,
            }),
            then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              Promise.resolve({
                data: [...this.table(name)].sort((a, b) =>
                  String(a.updated_at).localeCompare(String(b.updated_at)),
                ),
                error: null,
              }).then(resolve, reject),
          }),
        }),
      }),
    };
    // SAFETY: the object implements exactly the surface SyncEngine calls
    // (auth.getSession/onAuthStateChange + from().upsert/select().order().gt());
    // SupabaseClient's full type is unreachable without the real SDK generics.
    return client as unknown as SupabaseClient;
  }
}

/** One simulated device: its own storage factory, catalog and sync cursors. */
class Device {
  private readonly factory = new IDBFactory();

  constructor(readonly name: string) {}

  /** Opens the device (fresh process start): storage + catalog, like the app. */
  async open(): Promise<{ repo: Repository; sync: SyncEngine }> {
    // The IndexedDB adapter reads the global factory when it opens, and caches
    // the connection afterwards — pointing the global at this device's factory
    // is what keeps the two devices' stores apart inside one process.
    (globalThis as { indexedDB: IDBFactory }).indexedDB = this.factory;
    const repo = new Repository(new IndexedDbStorage());
    await repo.init();
    // SAFETY: data/foods.json is the checked-in catalog bundle; its JSON shape
    // is the CatalogBundle contract (the app's app-context.tsx casts the same way).
    await repo.ensureCatalog(catalogBundle as unknown as CatalogBundle);
    const sync = new SyncEngine(repo, () => cloudClient);
    await sync.initialize();
    return { repo, sync };
  }
}

// The adapter also consults the global IDBKeyRange; only `indexedDB` differs
// per device, so the key-range class is installed once for the process.
(globalThis as { IDBKeyRange: unknown }).IDBKeyRange = FakeIdbKeyRange;

const cloud = new FakeCloud();
const cloudClient = cloud.toClient();

/* ------------------------------------------------------------------ */
/* what a user actually logs                                           */
/* ------------------------------------------------------------------ */

const DAY = '2026-09-15';

async function seedUserData(repo: Repository) {
  const food = await repo.createUserFood(
    {
      name: 'Verify Oatmeal',
      category: 'Custom',
      caloriesPer100g: 150,
      proteinPer100g: 6.5,
      carbsPer100g: 27,
      fatPer100g: 2.5,
      servings: [{ id: 'g', label: 'g', grams: 1, approx: false }],
    },
    USER_ID,
  );
  const entry = await repo.addEntry({ logDate: DAY, foodId: food.id, servingId: 'g', amount: 200 });
  const measurement = await repo.addHealthMeasurement({ measuredAt: DAY, weightKg: 75, heightCm: 175 });
  const activity = await repo.upsertActivityDay({
    logDate: DAY,
    steps: 9123,
    activeKcal: 312,
    activeMinutes: 47,
  });
  await repo.saveProfile({ sex: 'male', birthYear: 1990 });
  // HR inputs are all present (weight + profile + avg HR), so this one takes
  // the heart-rate path.
  const workout = await repo.addWorkout({
    logDate: DAY,
    workoutType: 'jump_rope',
    durationMin: 12,
    avgHr: 148,
    peakHr: 171,
    manualCalories: null,
    notes: 'verify run',
  });
  // No average HR, so this one must fall back to the compendium MET row.
  const stairWorkout = await repo.addWorkout({
    logDate: DAY,
    workoutType: 'stairmaster',
    durationMin: 20,
    avgHr: null,
    peakHr: null,
    manualCalories: null,
    notes: null,
  });
  return { food, entry, measurement, activity, workout, stairWorkout };
}

/* ------------------------------------------------------------------ */
/* comparison                                                          */
/* ------------------------------------------------------------------ */

/** Live rows of one table, keyed by id and stripped of nothing (exact copy). */
async function snapshot(repo: Repository, table: string): Promise<Map<string, Row>> {
  const rows = await repo.listForSync(table as never);
  const live = rows.filter((r) => !r.deletedAt);
  return new Map(live.map((r) => [String(r.id), r]));
}

/** Rows queued locally but not yet confirmed by the server (push backlog). */
async function pendingPush(repo: Repository): Promise<number> {
  return (await repo.getUnsyncedChanges()).length;
}

const USER_TABLES = ['foods', 'daily_entries', 'health_measurements', 'saved_recipes', 'activity_days', 'workouts', 'user_profile'] as const;

async function compareDevices(
  label: string,
  a: Repository,
  b: Repository,
  expectUserFoodsOnly = true,
): Promise<void> {
  for (const table of USER_TABLES) {
    const left = await snapshot(a, table);
    const right = await snapshot(b, table);
    if (expectUserFoodsOnly && table === 'foods') {
      // catalog rows are seeded locally on each device; compare user rows only
      for (const [id, row] of [...left]) if (row.source !== 'user') left.delete(id);
      for (const [id, row] of [...right]) if (row.source !== 'user') right.delete(id);
    }
    const leftIds = [...left.keys()].sort();
    const rightIds = [...right.keys()].sort();
    if (leftIds.join() !== rightIds.join()) {
      check(
        `${label} · ${table} row ids`,
        false,
        `A has [${leftIds.join(', ')}] but B has [${rightIds.join(', ')}]`,
      );
      continue;
    }
    const mismatched = leftIds.filter(
      (id) => JSON.stringify(left.get(id)) !== JSON.stringify(right.get(id)),
    );
    check(
      `${label} · ${table} (${leftIds.length} row${leftIds.length === 1 ? '' : 's'})`,
      mismatched.length === 0,
      mismatched.length === 0
        ? leftIds.length === 0
          ? 'both empty (expected on a fresh device)'
          : 'identical payloads'
        : `differing rows: ${mismatched.join(', ')}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* the run                                                             */
/* ------------------------------------------------------------------ */

/** Parse a backup file the way the Settings import does, with a clear error. */
function parseBackupFile(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`backup file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  // The repository's importBackup re-validates every section (app tag, version,
  // row shape) — this only enforces the outer JSON-object boundary.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('backup file must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

async function main(): Promise<void> {
  console.log('Device-transfer verification (two isolated IndexedDB stores)');
  console.log('===========================================================');

  /* ---- 1. persistence across an app restart on device A ---- */
  section('1. Persistence on device A (write, then re-open the app)');
  const alice = new Device('device-A');
  const first = await alice.open();
  const seeded = await seedUserData(first.repo);
  const reopened = await alice.open(); // same factory, new Repository = app restart
  const persisted = {
    food: (await reopened.repo.getUserFoods()).some((f: UserFood) => f.id === seeded.food.id),
    entry: (await reopened.repo.getDailyEntries(DAY)).some((e: DailyEntry) => e.id === seeded.entry.id),
    measurement: (await reopened.repo.getHealthMeasurements()).some(
      (m: HealthMeasurement) => m.id === seeded.measurement.id,
    ),
    activity: (await reopened.repo.getActivityDay(DAY))?.id === seeded.activity.id,
    workout: (await reopened.repo.getWorkouts()).some((w: Workout) => w.id === seeded.workout.id),
    profile: (await reopened.repo.getProfile())?.birthYear === 1990,
  };
  check('food survives restart', persisted.food, 'user food readable after re-open');
  check('food entry survives restart', persisted.entry, `${DAY} entry readable`);
  check('measurement survives restart', persisted.measurement, 'weight/height readable');
  check('activity day survives restart', persisted.activity, `${DAY} steps 9123 readable`);
  check('workout survives restart', persisted.workout, 'jump rope row readable');
  check('profile survives restart', persisted.profile, 'sex/birth year readable');
  check(
    'write queue is durable',
    (await pendingPush(reopened.repo)) === 7,
    `${await pendingPush(reopened.repo)} unsynced changes queued (food, entry, measurement, activity, profile, 2 workouts)`,
  );
  check(
    'HR workout snapshotted from the heart-rate path',
    seeded.workout.caloriesSource === 'hr-estimate' && seeded.workout.calories > 0,
    `jump rope 12 min at 148 bpm → ${seeded.workout.calories} kcal (${seeded.workout.caloriesSource})`,
  );
  check(
    'MET workout snapshotted from the compendium row',
    seeded.stairWorkout.caloriesSource === 'met-estimate' && seeded.stairWorkout.calories === 244,
    `stairmaster 20 min at 75 kg → ${seeded.stairWorkout.calories} kcal (${seeded.stairWorkout.caloriesSource})`,
  );

  /* ---- 2. device B starts empty ---- */
  section('2. Isolation of device B (must start empty)');
  const bob = new Device('device-B');
  const second = await bob.open();
  const emptyCounts = await Promise.all(
    USER_TABLES.map(async (t) => {
      const rows = await snapshot(second.repo, t);
      // every device seeds the shared catalog locally — that is not user data
      if (t === 'foods') for (const [id, row] of [...rows]) if (row.source !== 'user') rows.delete(id);
      return [t, rows.size] as const;
    }),
  );
  check(
    'device B has no user data before any transfer',
    emptyCounts.every(([, n]) => n === 0),
    `${emptyCounts.map(([t, n]) => `${t}:${n}`).join(' ')} (catalog rows excluded)`,
  );
  check(
    'device B cannot see device A rows (stores are genuinely separate)',
    (await second.repo.getActivityDay(DAY)) === null &&
      (await second.repo.getDailyEntries(DAY)).length === 0,
    'day query on B returns nothing',
  );

  /* ---- 3. transfer via the JSON backup path ---- */
  section('3. Transfer A → B through the backup file (Settings → Export / Import)');
  const payload = await first.repo.exportBackup();
  const wire = JSON.stringify(payload); // exactly what a user copies between devices
  const roundTripped = parseBackupFile(wire);
  const imported = await second.repo.importBackup(roundTripped, { restore: false });
  check(
    'import reports the rows it took in',
    imported.userFoods === 1 &&
      imported.entries === 1 &&
      imported.measurements === 1 &&
      imported.activityDays === 1 &&
      imported.workouts === 2 &&
      imported.profile === 1,
    JSON.stringify(imported),
  );
  await compareDevices('backup', first.repo, second.repo);

  /* ---- 4. transfer via the sync engine, on a clean pair ---- */
  section('4. Transfer C → D through the sync engine (shared remote, no backup file)');
  cloud.tables.clear();
  const carol = new Device('device-C');
  const dave = new Device('device-D');
  const third = await carol.open();
  const fourth = await dave.open();
  await seedUserData(third.repo);
  const pushResult = await third.sync.sync();
  const pushedByTable = [...cloud.tables.entries()]
    .map(([t, rows]) => `${t}:${rows.length}`)
    .sort()
    .join(' ');
  check('C pushed its queued changes', pushResult.pushed === 7, `pushed ${pushResult.pushed} rows`);
  check('remote received every table', pushedByTable.split(' ').length === 7, pushedByTable);
  check(
    'C has nothing left queued after a confirmed push',
    (await pendingPush(third.repo)) === 0,
    `${await pendingPush(third.repo)} pending`,
  );

  const pullResult = await fourth.sync.sync();
  check('D pulled the remote rows', pullResult.pulled === 7, `pulled ${pullResult.pulled}, applied ${pullResult.applied}`);
  await compareDevices('sync', third.repo, fourth.repo);
  check(
    'D computes the same energy balance as C',
    JSON.stringify(await third.repo.getEnergySummary('day', DAY)) ===
      JSON.stringify(await fourth.repo.getEnergySummary('day', DAY)),
    JSON.stringify(await fourth.repo.getEnergySummary('day', DAY)),
  );

  /* ---- 5. deletions propagate ---- */
  section('5. Deletion on C propagates to D');
  const workoutOnC = (await third.repo.getWorkouts())[0];
  const dayOnC = await third.repo.getActivityDay(DAY);
  if (!workoutOnC || !dayOnC) {
    check('fixture present to delete', false, 'no workout/activity day found on C');
  } else {
    await third.repo.deleteWorkout(workoutOnC.id);
    await third.repo.deleteActivityDay(dayOnC.id);
    await third.sync.sync();
    await fourth.sync.sync();
    check(
      'deleted workout is gone on D',
      !(await fourth.repo.getWorkouts()).some((w: Workout) => w.id === workoutOnC.id),
      `${(await fourth.repo.getWorkouts()).length} workout(s) left on D`,
    );
    check(
      'activity day is gone on D',
      (await fourth.repo.getActivityDay(DAY)) === null,
      'day query on D returns nothing',
    );
    check(
      'D still keeps the other rows',
      (await fourth.repo.getDailyEntries(DAY)).length === 1 &&
        (await fourth.repo.getUserFoods()).length === 1 &&
        (await fourth.repo.getWorkouts()).length === 1,
      'entry, food and the second workout untouched',
    );
  }

  /* ---- 6. re-open after transfer (nothing is memory-only) ---- */
  section('6. Both devices re-open with the transferred data intact');
  const carolAgain = await carol.open();
  const daveAgain = await dave.open();
  await compareDevices('post-restart', carolAgain.repo, daveAgain.repo);

  /* ---- report ---- */
  section('Not covered by this script');
  console.log('  - a real Supabase project: the remote above is an in-memory stand-in');
  console.log('    (this checkout has no EXPO_PUBLIC_SUPABASE_URL/ANON_KEY), so auth,');
  console.log('    RLS and 003_activity.sql were never executed against Postgres');
  console.log('  - the Android SQLite adapter: only the web IndexedDB path is exercised');
  console.log('  - physical devices and the UI: this drives the repository/sync layers');

  console.log(
    `\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} — ${checks - failures}/${checks} passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('\nVerification crashed:', e);
  process.exitCode = 1;
});
