/**
 * Activity days, workouts and the profile over the real web storage path:
 * one row per activity date, calorie snapshots taken at write time, profile
 * validation, and backup round-tripping of the new tables.
 */
import { IndexedDbStorage } from '@/db/indexeddb';
import { Repository } from '@/db/repository';
import { TABLES } from '@/db/schema';
import type { CatalogBundle } from '@/db/seedCatalog';
import { ValidationError } from '@/domain/errors';
import type { ActivityDay } from '@/domain/types';
import { beforeEach, describe, expect, it } from 'vitest';
import bundle from '../data/foods.json';

async function makeRepo(): Promise<Repository> {
  const repo = new Repository(new IndexedDbStorage());
  await repo.init();
  await repo.ensureCatalog(bundle as unknown as CatalogBundle);
  return repo;
}

async function wipe(): Promise<void> {
  const storage = new IndexedDbStorage();
  await storage.init();
  for (const t of Object.keys(TABLES)) await storage.clear(t);
}

beforeEach(async () => {
  await wipe();
});

const workoutInput = {
  logDate: '2026-08-17',
  workoutType: 'cycling',
  durationMin: 40,
  avgHr: null,
  peakHr: null,
  manualCalories: null,
  notes: null,
} as const;

describe('activity days', () => {
  it('keeps exactly one live row per date and updates it in place', async () => {
    const repo = await makeRepo();
    const first = await repo.upsertActivityDay({
      logDate: '2026-08-17',
      steps: 8000,
      activeKcal: 250,
      activeMinutes: 40,
    });
    const second = await repo.upsertActivityDay({
      logDate: '2026-08-17',
      steps: 12000,
      activeKcal: 380.4,
      activeMinutes: 55,
    });

    expect(second.id).toBe(first.id); // same row, updated
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt >= first.updatedAt).toBe(true);
    expect(second).toMatchObject({ steps: 12000, activeKcal: 380, activeMinutes: 55 });

    const days = await repo.getActivityDays();
    expect(days.length).toBe(1);
    expect(await repo.getActivityDay('2026-08-17')).toMatchObject({ id: first.id, steps: 12000 });
    // a different date is a different row
    const other = await repo.upsertActivityDay({
      logDate: '2026-08-16',
      steps: 100,
      activeKcal: 10,
      activeMinutes: 5,
    });
    expect(other.id).not.toBe(first.id);
    expect((await repo.getActivityDays()).map((d) => d.logDate)).toEqual(['2026-08-17', '2026-08-16']);
    expect((await repo.getActivityDays('2026-08-17', '2026-08-17')).length).toBe(1);
  });

  it('tombstones a deleted day but keeps it for sync', async () => {
    const repo = await makeRepo();
    const day = await repo.upsertActivityDay({
      logDate: '2026-08-17',
      steps: 8000,
      activeKcal: 250,
      activeMinutes: 40,
    });
    await repo.deleteActivityDay(day.id);
    expect(await repo.getActivityDays()).toEqual([]);
    expect(await repo.getActivityDay('2026-08-17')).toBeNull();
    const rows = await repo.listForSync('activity_days');
    expect((rows[0] as unknown as ActivityDay).deletedAt).not.toBeNull();
    const queue = await repo.getUnsyncedChanges();
    expect(queue.some((q) => q.table === 'activity_days' && q.op === 'delete')).toBe(true);
    // the date becomes writable again with a fresh row
    const again = await repo.upsertActivityDay({
      logDate: '2026-08-17',
      steps: 1,
      activeKcal: 1,
      activeMinutes: 1,
    });
    expect(again.id).not.toBe(day.id);
  });

  it('validates date, steps, kcal and minutes', async () => {
    const repo = await makeRepo();
    const ok = { logDate: '2026-08-17', steps: 100, activeKcal: 10, activeMinutes: 5 };
    await expect(repo.upsertActivityDay({ ...ok, logDate: '2026-02-30' })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.upsertActivityDay({ ...ok, steps: -1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.upsertActivityDay({ ...ok, steps: 1.5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.upsertActivityDay({ ...ok, activeMinutes: 2.5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.upsertActivityDay({ ...ok, activeKcal: -10 })).rejects.toBeInstanceOf(ValidationError);
    expect((await repo.getActivityDays()).length).toBe(0);
  });
});

describe('steps calorie estimate', () => {
  /** 180 cm, 75 kg, male: 0.747 m per step, so 10 000 steps is 7.47 km ≈ 280 kcal. */
  async function withBody(repo: Repository): Promise<void> {
    await repo.saveProfile({ sex: 'male', birthYear: 1990 });
    await repo.addHealthMeasurement({ measuredAt: '2026-08-01', weightKg: 75, heightCm: 180 });
  }

  it('estimates from the steps when no calories are entered', async () => {
    const repo = await makeRepo();
    await withBody(repo);
    const day = await repo.upsertActivityDay({
      logDate: '2026-08-17',
      steps: 10000,
      activeKcal: null,
      activeMinutes: 60,
    });
    expect(day).toMatchObject({ activeKcal: 280, kcalSource: 'steps-estimate' });
  });

  it('uses an entered value as given, whatever the steps suggest', async () => {
    const repo = await makeRepo();
    await withBody(repo);
    const day = await repo.upsertActivityDay({
      logDate: '2026-08-17',
      steps: 10000,
      activeKcal: 999,
      activeMinutes: 60,
    });
    expect(day).toMatchObject({ activeKcal: 999, kcalSource: 'manual' });
  });

  it('rejects a blank calorie entry when it has nothing to estimate from', async () => {
    const repo = await makeRepo();
    await expect(
      repo.upsertActivityDay({ logDate: '2026-08-17', steps: 10000, activeKcal: null, activeMinutes: 60 }),
    ).rejects.toThrow(/height and weight/i);
    expect(await repo.getActivityDays()).toEqual([]);

    // A weight alone is not enough — the stride comes from height.
    await repo.addHealthMeasurement({ measuredAt: '2026-08-01', weightKg: 75, heightCm: null });
    await expect(
      repo.upsertActivityDay({ logDate: '2026-08-17', steps: 10000, activeKcal: null, activeMinutes: 60 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('estimates with the body metrics in force on the day being written', async () => {
    const repo = await makeRepo();
    await repo.saveProfile({ sex: 'male', birthYear: 1990 });
    await repo.addHealthMeasurement({ measuredAt: '2026-08-01', weightKg: 75, heightCm: 180 });
    await repo.addHealthMeasurement({ measuredAt: '2026-08-10', weightKg: 90, heightCm: null });

    const before = await repo.upsertActivityDay({
      logDate: '2026-08-09',
      steps: 10000,
      activeKcal: null,
      activeMinutes: 60,
    });
    const after = await repo.upsertActivityDay({
      logDate: '2026-08-10',
      steps: 10000,
      activeKcal: null,
      activeMinutes: 60,
    });
    // 7.47 km × 0.5 kcal/kg/km: 280 kcal at 75 kg, 336 kcal at 90 kg.
    expect(before.activeKcal).toBe(280);
    expect(after.activeKcal).toBe(336);
  });

  it('feeds the estimate into the day energy balance as active burn', async () => {
    const repo = await makeRepo();
    await withBody(repo);
    await repo.upsertActivityDay({ logDate: '2026-08-17', steps: 10000, activeKcal: null, activeMinutes: 60 });

    const [row] = await repo.getDailyEnergy('2026-08-17', '2026-08-17');
    expect(row).toMatchObject({ activeCalories: 280, restingCalories: 1700, burnCalories: 1980 });
  });
});

describe('workouts', () => {
  it('snapshots the MET estimate at write time and never recomputes it', async () => {
    const repo = await makeRepo();
    await repo.addHealthMeasurement({ measuredAt: '2026-08-01', weightKg: 75, heightCm: null });
    const workout = await repo.addWorkout(workoutInput); // cycling 7.5 MET

    // 7.0 MET (01014, cycling general) × 3.5 × 75 kg / 200 = 9.19 kcal/min × 40 min = 367.5 → 368
    expect(workout).toMatchObject({ calories: 368, caloriesSource: 'met-estimate', durationMin: 40 });
    await repo.addHealthMeasurement({ measuredAt: '2026-08-20', weightKg: 95, heightCm: null });
    expect((await repo.getWorkouts())[0]!.calories).toBe(368); // history unchanged
  });

  it('uses the stored profile and latest weight for the HR estimate', async () => {
    const repo = await makeRepo();
    await repo.saveProfile({ sex: 'male', birthYear: 1990 });
    await repo.addHealthMeasurement({ measuredAt: '2026-08-01', weightKg: 75, heightCm: null });
    const workout = await repo.addWorkout({
      ...workoutInput,
      workoutType: 'running',
      durationMin: 30,
      avgHr: 150,
      peakHr: 171,
    });
    expect(workout).toMatchObject({ calories: 442, caloriesSource: 'hr-estimate' });

    // peak HR is stored for display only and never changes the estimate
    const twin = await repo.addWorkout({
      ...workoutInput,
      workoutType: 'running',
      durationMin: 30,
      avgHr: 150,
      peakHr: 200,
    });
    expect(twin.calories).toBe(workout.calories);
  });

  it('honours a manual calorie override and reports its source', async () => {
    const repo = await makeRepo();
    const workout = await repo.addWorkout({ ...workoutInput, manualCalories: 512 });
    expect(workout).toMatchObject({ calories: 512, caloriesSource: 'manual' });
  });

  it('recomputes calories on update and applies the new edit fields', async () => {
    const repo = await makeRepo();
    await repo.addHealthMeasurement({ measuredAt: '2026-08-01', weightKg: 75, heightCm: null });
    const workout = await repo.addWorkout(workoutInput);
    expect(workout.caloriesSource).toBe('met-estimate');

    const updated = await repo.updateWorkout(workout.id, {
      ...workoutInput,
      workoutType: 'running',
      durationMin: 30,
      manualCalories: null,
      notes: '  intervals  ',
    });
    expect(updated.id).toBe(workout.id);
    expect(updated).toMatchObject({ workoutType: 'running', durationMin: 30, calories: 366, caloriesSource: 'met-estimate' });
    expect(updated.notes).toBe('intervals');

    const overridden = await repo.updateWorkout(workout.id, {
      ...workoutInput,
      notes: null,
      manualCalories: 600,
    });
    expect(overridden).toMatchObject({ calories: 600, caloriesSource: 'manual', notes: null });
  });

  it('rejects inputs it cannot turn into a calorie value', async () => {
    const repo = await makeRepo();
    // no weight, no HR inputs, unknown type → nothing to estimate from
    await expect(
      repo.addWorkout({ ...workoutInput, workoutType: 'kayaking' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.addWorkout({ ...workoutInput, durationMin: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.addWorkout({ ...workoutInput, workoutType: '  ' })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.addWorkout({ ...workoutInput, logDate: 'bad' })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.addWorkout({ ...workoutInput, avgHr: -1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.addWorkout({ ...workoutInput, manualCalories: -3 })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      repo.addWorkout({ ...workoutInput, avgHr: 150, peakHr: 120 }),
    ).rejects.toThrow(/peak heart rate/i);
    expect(await repo.getWorkouts()).toEqual([]);
  });

  it('ranges, edits and tombstones workouts', async () => {
    const repo = await makeRepo();
    const older = await repo.addWorkout({ ...workoutInput, logDate: '2026-08-10', manualCalories: 100 });
    const newer = await repo.addWorkout({ ...workoutInput, logDate: '2026-08-17', manualCalories: 200 });
    expect((await repo.getWorkouts()).map((w) => w.logDate)).toEqual(['2026-08-17', '2026-08-10']);
    expect((await repo.getWorkouts('2026-08-11', '2026-08-31')).map((w) => w.id)).toEqual([newer.id]);

    await repo.deleteWorkout(older.id);
    expect((await repo.getWorkouts()).map((w) => w.id)).toEqual([newer.id]);
    await expect(repo.updateWorkout(older.id, workoutInput)).rejects.toThrow(/not found/i);
  });
});

describe('profile', () => {
  it('round-trips sex and birth year, creating the row on first save', async () => {
    const repo = await makeRepo();
    expect(await repo.getProfile()).toBeNull();

    const saved = await repo.saveProfile({ sex: 'female', birthYear: 1995 });
    expect(saved).toMatchObject({ id: 'profile', sex: 'female', birthYear: 1995, deletedAt: null });
    expect(await repo.getProfile()).toMatchObject({ sex: 'female', birthYear: 1995 });

    const updated = await repo.saveProfile({ sex: 'female', birthYear: 1994 });
    expect(updated.id).toBe('profile');
    expect(updated.createdAt).toBe(saved.createdAt);
    expect(updated.birthYear).toBe(1994);

    // both fields are optional (the user may decline to disclose either)
    expect(await repo.saveProfile({ sex: null, birthYear: null })).toMatchObject({
      sex: null,
      birthYear: null,
    });
    expect((await repo.listForSync('user_profile')).length).toBe(1);
  });

  it('validates the birth year and the sex value', async () => {
    const repo = await makeRepo();
    const year = new Date().getFullYear();
    await expect(repo.saveProfile({ sex: 'male', birthYear: 1899 })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.saveProfile({ sex: 'male', birthYear: year + 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.saveProfile({ sex: 'male', birthYear: 1990.5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      repo.saveProfile({ sex: 'other' as never, birthYear: 1990 }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await repo.getProfile()).toBeNull();
  });
});

describe('backup', () => {
  it('exports and re-imports activity days, workouts and the profile', async () => {
    const repo = await makeRepo();
    const day = await repo.upsertActivityDay({
      logDate: '2026-08-17',
      steps: 9000,
      activeKcal: 300,
      activeMinutes: 45,
    });
    const workout = await repo.addWorkout({ ...workoutInput, manualCalories: 250 });
    await repo.saveProfile({ sex: 'male', birthYear: 1990 });

    const backup = await repo.exportBackup();
    expect(backup.version).toBe(3);
    expect(backup.activityDays.map((d) => d.id)).toEqual([day.id]);
    expect(backup.workouts.map((w) => w.id)).toEqual([workout.id]);
    expect(backup.profile).toMatchObject({ sex: 'male', birthYear: 1990 });

    const fresh = await makeRepo();
    const result = await fresh.importBackup(backup, { restore: false });
    expect(result).toMatchObject({ activityDays: 1, workouts: 1, profile: 1 });
    expect(await fresh.getActivityDay('2026-08-17')).toMatchObject({ steps: 9000, activeKcal: 300 });
    expect((await fresh.getWorkouts())[0]).toMatchObject({ calories: 250, caloriesSource: 'manual' });
    expect(await fresh.getProfile()).toMatchObject({ sex: 'male', birthYear: 1990 });

    // a version-2 backup (no activity sections) still imports
    const v2 = { ...backup, version: 2, activityDays: undefined, workouts: undefined, profile: undefined };
    await wipe(); // a second device with an empty local store
    const legacy = await makeRepo();
    const legacyResult = await legacy.importBackup(v2, { restore: false });
    expect(legacyResult).toMatchObject({ activityDays: 0, workouts: 0, profile: 0 });
    expect(await legacy.getActivityDays()).toEqual([]);
    expect(await legacy.getWorkouts()).toEqual([]);
    expect(await legacy.getProfile()).toBeNull();
  });

  it('restore clears local activity, workouts and profile', async () => {
    const repo = await makeRepo();
    await repo.upsertActivityDay({ logDate: '2026-08-17', steps: 1, activeKcal: 1, activeMinutes: 1 });
    await repo.addWorkout({ ...workoutInput, manualCalories: 100 });
    await repo.saveProfile({ sex: 'male', birthYear: 1990 });
    const backup = await repo.exportBackup();

    await repo.upsertActivityDay({ logDate: '2026-08-18', steps: 2, activeKcal: 2, activeMinutes: 2 });
    await repo.addWorkout({ ...workoutInput, logDate: '2026-08-18', manualCalories: 200 });
    await repo.saveProfile({ sex: 'female', birthYear: 2000 });

    await repo.importBackup(backup, { restore: true });
    expect((await repo.getActivityDays()).map((d) => d.logDate)).toEqual(['2026-08-17']);
    expect((await repo.getWorkouts()).map((w) => w.logDate)).toEqual(['2026-08-17']);
    expect(await repo.getProfile()).toMatchObject({ sex: 'male', birthYear: 1990 });
  });

  it('rejects malformed activity, workout and profile sections', async () => {
    const repo = await makeRepo();
    const base = await repo.exportBackup();
    await expect(
      repo.importBackup({ ...base, activityDays: [{ bad: true }] }, { restore: false }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      repo.importBackup({ ...base, workouts: [{ id: 'x', updatedAt: 'now' }] }, { restore: false }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      repo.importBackup({ ...base, profile: { id: 'someone-else', updatedAt: 'now' } }, { restore: false }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
