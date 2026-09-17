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
      restingCalories: null,
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
    // The measurement carries a weight but no height, so there is no baseline to
    // add: burn is exactly the logged activity and workout.
    expect(summary).toEqual({
      range: 'day',
      from: '2026-08-17',
      to: '2026-08-17',
      intakeCalories: 1200,
      restingCalories: null,
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
      {
        logDate: '2026-08-10',
        intakeCalories: 900,
        activeCalories: 0,
        restingCalories: null,
        burnCalories: 0,
        netCalories: 900,
      },
      {
        logDate: '2026-08-12',
        intakeCalories: 0,
        activeCalories: 400,
        restingCalories: null,
        burnCalories: 400,
        netCalories: -400,
      },
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

describe('resting baseline', () => {
  /**
   * A profile and a dated weight/height pair. Age on 2026-08-17 is 36, so the
   * Mifflin-St Jeor baseline is 10×75 + 6.25×180 − 5×36 + 5 = 1700 kcal/day.
   */
  async function withBaseline(repo: Repository): Promise<void> {
    await repo.saveProfile({ sex: 'male', birthYear: 1990 });
    await repo.addHealthMeasurement({ measuredAt: '2026-08-01', weightKg: 75, heightCm: 180 });
  }

  it('adds the baseline to a day that also has logged burn', async () => {
    const repo = await makeRepo();
    const food = await denseFood(repo);
    await withBaseline(repo);
    await repo.addEntry({ logDate: '2026-08-17', foodId: food.id, servingId: 'g', amount: 1200 });
    await repo.upsertActivityDay({ logDate: '2026-08-17', steps: 9000, activeKcal: 300, activeMinutes: 45 });

    const summary = await repo.getEnergySummary('day', '2026-08-17');
    expect(summary.restingCalories).toBe(1700);
    expect(summary.burnCalories).toBe(1700 + 300);
    expect(summary.netCalories).toBe(1200 - (1700 + 300));

    const [row] = await repo.getDailyEnergy('2026-08-17', '2026-08-17');
    expect(row).toMatchObject({
      activeCalories: 300,
      restingCalories: 1700,
      burnCalories: 2000,
    });
  });

  it('counts the baseline on unlogged days of a range without emitting rows for them', async () => {
    const repo = await makeRepo();
    const food = await denseFood(repo);
    await withBaseline(repo);
    await repo.addEntry({ logDate: '2026-08-17', foodId: food.id, servingId: 'g', amount: 1200 });
    await repo.upsertActivityDay({ logDate: '2026-08-17', steps: 9000, activeKcal: 300, activeMinutes: 45 });

    const week = await repo.getEnergySummary('week', '2026-08-19');
    expect([week.from, week.to]).toEqual(['2026-08-17', '2026-08-23']);
    expect(week.intakeCalories).toBe(1200);
    // Every day of the week carries it, not just the one that was logged.
    expect(week.restingCalories).toBe(1700 * 7);
    expect(week.burnCalories).toBe(1700 * 7 + 300);
    expect(week.netCalories).toBe(1200 - (1700 * 7 + 300));

    // The chart still only gets the day that was logged.
    const daily = await repo.getDailyEnergy('2026-08-17', '2026-08-23');
    expect(daily.map((d) => d.logDate)).toEqual(['2026-08-17']);
  });

  it('ignores a measurement recorded after the day being reported on', async () => {
    const repo = await makeRepo();
    await repo.saveProfile({ sex: 'male', birthYear: 1990 });
    await repo.addHealthMeasurement({ measuredAt: '2026-09-01', weightKg: 75, heightCm: 180 });

    const summary = await repo.getEnergySummary('day', '2026-08-17');
    expect(summary.restingCalories).toBeNull();
    expect(summary.burnCalories).toBe(0);
  });

  it('carries weight and height forward independently, and takes a newer value from its date', async () => {
    const repo = await makeRepo();
    await repo.saveProfile({ sex: 'male', birthYear: 1990 });
    await repo.addHealthMeasurement({ measuredAt: '2026-08-01', weightKg: 75, heightCm: null });
    await repo.addHealthMeasurement({ measuredAt: '2026-08-10', weightKg: null, heightCm: 180 });
    await repo.addHealthMeasurement({ measuredAt: '2026-08-14', weightKg: 85, heightCm: null });

    // Weight alone is not enough for a baseline.
    expect((await repo.getEnergySummary('day', '2026-08-05')).restingCalories).toBeNull();
    // The height has arrived; the 75 kg weight is still the latest one.
    expect((await repo.getEnergySummary('day', '2026-08-12')).restingCalories).toBe(1700);
    // A newer weight takes over from the day it was measured: 10×85 + 6.25×180 − 5×36 + 5.
    expect((await repo.getEnergySummary('day', '2026-08-14')).restingCalories).toBe(1800);
  });

  it('needs a birth year, and uses the neutral constant when no sex is disclosed', async () => {
    const repo = await makeRepo();
    await repo.saveProfile({ sex: 'male', birthYear: null });
    await repo.addHealthMeasurement({ measuredAt: '2026-08-01', weightKg: 75, heightCm: 180 });
    expect((await repo.getEnergySummary('day', '2026-08-17')).restingCalories).toBeNull();

    await repo.saveProfile({ sex: null, birthYear: 1990 });
    // 10×75 + 6.25×180 − 5×36 − 78 = 1617, between the male and female values.
    expect((await repo.getEnergySummary('day', '2026-08-17')).restingCalories).toBe(1617);
  });
});
