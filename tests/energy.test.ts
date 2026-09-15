/**
 * Energy balance: the domain intake−burn helper and the repository
 * aggregations that feed the Activity tab (day / week / month).
 */
import { IndexedDbStorage } from '@/db/indexeddb';
import { Repository } from '@/db/repository';
import { TABLES } from '@/db/schema';
import type { CatalogBundle } from '@/db/seedCatalog';
import { netEnergy } from '@/domain/energy';
import { ValidationError } from '@/domain/errors';
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

/** A food with 100 kcal per gram-free serving, so entry calories are readable. */
async function denseFood(repo: Repository) {
  return repo.createUserFood(
    {
      name: 'Energy Bar',
      caloriesPer100g: 100,
      proteinPer100g: 1,
      carbsPer100g: 1,
      fatPer100g: 1,
      servings: [{ id: 'g', label: 'g', grams: 1, approx: false }],
    },
    'u1',
  );
}

describe('netEnergy', () => {
  it('is intake minus burn, keeping the sign', () => {
    expect(netEnergy(2000, 500)).toEqual({ burn: 500, net: 1500 });
    expect(netEnergy(1800, 2200)).toEqual({ burn: 2200, net: -400 });
    expect(netEnergy(0, 0)).toEqual({ burn: 0, net: 0 });
  });

  it('rejects negative or non-finite totals', () => {
    expect(() => netEnergy(-1, 0)).toThrow(RangeError);
    expect(() => netEnergy(0, -1)).toThrow(RangeError);
    expect(() => netEnergy(Number.NaN, 0)).toThrow(RangeError);
    expect(() => netEnergy(0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('getEnergySummary', () => {
  it('reports zeros for a range with no data', async () => {
    const repo = await makeRepo();
    expect(await repo.getEnergySummary('day', '2026-09-01')).toEqual({
      range: 'day',
      from: '2026-09-01',
      to: '2026-09-01',
      intakeCalories: 0,
      burnCalories: 0,
      netCalories: 0,
      workoutCount: 0,
    });
  });

  it('nets intake against activity and workout burn for a day', async () => {
    const repo = await makeRepo();
    const food = await denseFood(repo);
    await repo.addEntry({ logDate: '2026-08-17', foodId: food.id, servingId: 'g', amount: 500 });
    await repo.addEntry({ logDate: '2026-08-17', foodId: food.id, servingId: 'g', amount: 700 });
    await repo.upsertActivityDay({ logDate: '2026-08-17', steps: 9000, activeKcal: 300, activeMinutes: 45 });
    await repo.saveProfile({ sex: 'male', birthYear: 1990 });
    await repo.addHealthMeasurement({ measuredAt: '2026-08-01', weightKg: 75, heightCm: null });
    const workout = await repo.addWorkout({
      logDate: '2026-08-17',
      workoutType: 'running',
      durationMin: 30,
      avgHr: 150,
      peakHr: 172,
      manualCalories: null,
      notes: null,
    });

    expect(workout.caloriesSource).toBe('hr-estimate');
    const summary = await repo.getEnergySummary('day', '2026-08-17');
    expect(summary).toEqual({
      range: 'day',
      from: '2026-08-17',
      to: '2026-08-17',
      intakeCalories: 1200,
      burnCalories: 300 + workout.calories,
      netCalories: 1200 - (300 + workout.calories),
      workoutCount: 1,
    });
  });

  it('buckets the ISO week and the calendar month around an anchor date', async () => {
    const repo = await makeRepo();
    const food = await denseFood(repo);
    await repo.addEntry({ logDate: '2026-08-17', foodId: food.id, servingId: 'g', amount: 100 }); // Monday
    await repo.addEntry({ logDate: '2026-08-23', foodId: food.id, servingId: 'g', amount: 200 }); // Sunday
    await repo.addEntry({ logDate: '2026-08-24', foodId: food.id, servingId: 'g', amount: 400 }); // next week
    await repo.addEntry({ logDate: '2026-07-31', foodId: food.id, servingId: 'g', amount: 800 }); // previous month

    const week = await repo.getEnergySummary('week', '2026-08-19');
    expect([week.from, week.to]).toEqual(['2026-08-17', '2026-08-23']);
    expect(week.intakeCalories).toBe(300);

    const month = await repo.getEnergySummary('month', '2026-08-19');
    expect([month.from, month.to]).toEqual(['2026-08-01', '2026-08-31']);
    expect(month.intakeCalories).toBe(700);
  });

  it('ignores deleted entries, activity days and workouts', async () => {
    const repo = await makeRepo();
    const food = await denseFood(repo);
    const entry = await repo.addEntry({ logDate: '2026-08-17', foodId: food.id, servingId: 'g', amount: 500 });
    const day = await repo.upsertActivityDay({ logDate: '2026-08-17', steps: 100, activeKcal: 200, activeMinutes: 20 });
    const workout = await repo.addWorkout({
      logDate: '2026-08-17',
      workoutType: 'yoga',
      durationMin: 30,
      avgHr: null,
      peakHr: null,
      manualCalories: 100,
      notes: null,
    });
    expect((await repo.getEnergySummary('day', '2026-08-17')).burnCalories).toBe(300);

    await repo.deleteEntry(entry.id);
    await repo.deleteActivityDay(day.id);
    await repo.deleteWorkout(workout.id);
    expect(await repo.getEnergySummary('day', '2026-08-17')).toMatchObject({
      intakeCalories: 0,
      burnCalories: 0,
      netCalories: 0,
      workoutCount: 0,
    });
  });

  it('validates the anchor date', async () => {
    const repo = await makeRepo();
    await expect(repo.getEnergySummary('day', '2026-02-30')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('getDailyEnergy', () => {
  it('emits one row per day with data and skips empty days (chart gaps)', async () => {
    const repo = await makeRepo();
    const food = await denseFood(repo);
    await repo.addEntry({ logDate: '2026-08-10', foodId: food.id, servingId: 'g', amount: 900 });
    await repo.upsertActivityDay({ logDate: '2026-08-12', steps: 1000, activeKcal: 150, activeMinutes: 30 });
    await repo.addWorkout({
      logDate: '2026-08-12',
      workoutType: 'cycling',
      durationMin: 40,
      avgHr: null,
      peakHr: null,
      manualCalories: 250,
      notes: null,
    });

    const daily = await repo.getDailyEnergy('2026-08-10', '2026-08-13');
    expect(daily).toEqual([
      { logDate: '2026-08-10', intakeCalories: 900, burnCalories: 0, netCalories: 900 },
      { logDate: '2026-08-12', intakeCalories: 0, burnCalories: 400, netCalories: -400 },
    ]);
    // 2026-08-11 and 2026-08-13 are absent (no data), never zero-filled
    expect(daily.some((d) => d.logDate === '2026-08-11')).toBe(false);
  });

  it('returns an empty list when nothing falls in the range', async () => {
    const repo = await makeRepo();
    expect(await repo.getDailyEnergy('2026-01-01', '2026-01-31')).toEqual([]);
  });

  it('rejects an inverted range', async () => {
    const repo = await makeRepo();
    await expect(repo.getDailyEnergy('2026-08-10', '2026-08-09')).rejects.toBeInstanceOf(ValidationError);
  });
});
