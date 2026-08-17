/**
 * Repository behavior over the real web storage path (IndexedDB via
 * fake-indexeddb) with the actual seeded catalog.
 */
import { IndexedDbStorage } from '@/db/indexeddb';
import { Repository, ValidationError } from '@/db/repository';
import { TABLES } from '@/db/schema';
import type { CatalogBundle } from '@/db/seedCatalog';
import type { DailyEntry } from '@/domain/types';
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

async function broccoli(repo: Repository) {
  const foods = await repo.searchFoods('Broccoli', 1);
  expect(foods.length).toBe(1);
  return foods[0]!;
}

describe('catalog seeding', () => {
  it('imports the catalog idempotently (version skip)', async () => {
    const repo = await makeRepo();
    const meta = await repo.getCatalogMetadata();
    expect(meta?.version).toBe(bundle.metadata.version);
    expect(meta?.foodCount).toBe(bundle.foods.length);
    const count = (await repo.searchFoods('')).length;
    await repo.ensureCatalog(bundle as unknown as CatalogBundle); // second import
    expect((await repo.searchFoods('')).length).toBe(count);
  });

  it('catalog refresh never touches user foods', async () => {
    const repo = await makeRepo();
    await repo.createUserFood({ name: 'My Granola', caloriesPer100g: 400, servings: [{ id: 'g', label: 'g', grams: 1, approx: false }] }, 'user-1');
    await repo.ensureCatalog(bundle as unknown as CatalogBundle);
    const user = await repo.getUserFoods();
    expect(user.map((f) => f.name)).toEqual(['My Granola']);
  });
});

describe('daily entries', () => {
  it('adds an entry computing grams and calories from the serving', async () => {
    const repo = await makeRepo();
    const b = await broccoli(repo);
    const entry = await repo.addEntry({ logDate: '2026-08-17', foodId: b.id, servingId: 'sv-cup', amount: 1 });
    expect(entry.grams).toBe(76); // official FDC cup weight for broccoli
    expect(entry.calories).toBe(24); // 32 kcal/100g × 76 g
    expect(entry.foodName).toBe('Broccoli, raw');
    expect(entry.servingLabel).toBe('cup');
    expect(entry.logDate).toBe('2026-08-17');
    const entries = await repo.getDailyEntries('2026-08-17');
    expect(entries.length).toBe(1);
    expect(await repo.getDailyEntries('2026-08-18')).toEqual([]);
  });

  it('validates date, food, serving, and amount at the boundary', async () => {
    const repo = await makeRepo();
    const b = await broccoli(repo);
    await expect(repo.addEntry({ logDate: '2026-02-30', foodId: b.id, servingId: 'sv-cup', amount: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.addEntry({ logDate: '2026-08-17', foodId: 'missing', servingId: 'sv-cup', amount: 1 })).rejects.toThrow(/not found/i);
    await expect(repo.addEntry({ logDate: '2026-08-17', foodId: b.id, servingId: 'sv-nope', amount: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.addEntry({ logDate: '2026-08-17', foodId: b.id, servingId: 'sv-cup', amount: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.addEntry({ logDate: '2026-08-17', foodId: b.id, servingId: 'sv-cup', amount: -2 })).rejects.toBeInstanceOf(ValidationError);
  });

  it('edits and deletes a PRIOR day through the identical path', async () => {
    const repo = await makeRepo();
    const b = await broccoli(repo);
    const entry = await repo.addEntry({ logDate: '2026-08-10', foodId: b.id, servingId: 'sv-cup', amount: 1 });
    const updated = await repo.updateEntry(entry.id, { amount: 2 });
    expect(updated.calories).toBe(49); // 32 kcal/100g × 2 × 76 g = 48.64 → 49
    expect(updated.amount).toBe(2);
    await repo.deleteEntry(entry.id);
    expect(await repo.getDailyEntries('2026-08-10')).toEqual([]);
    // tombstone retained for sync
    const rows = await repo.listForSync('daily_entries');
    expect(rows.length).toBe(1);
    expect((rows[0] as unknown as DailyEntry).deletedAt).not.toBeNull();
    const queue = await repo.getUnsyncedChanges();
    expect(queue.some((q) => q.table === 'daily_entries' && q.op === 'delete' && q.id === entry.id)).toBe(true);
  });

  it('keeps entry snapshots when the food changes', async () => {
    const repo = await makeRepo();
    const food = await repo.createUserFood({ name: 'Smoothie', caloriesPer100g: 100, servings: [{ id: 'g', label: 'g', grams: 1, approx: false }] }, 'u1');
    const entry = await repo.addEntry({ logDate: '2026-08-17', foodId: food.id, servingId: 'g', amount: 100 });
    expect(entry.calories).toBe(100);
    await repo.updateUserFood(food.id, { name: 'Smoothie', caloriesPer100g: 300, servings: [{ id: 'g', label: 'g', grams: 1, approx: false }] });
    const after = await repo.getDailyEntries('2026-08-17');
    expect(after[0]!.calories).toBe(100); // history unchanged
    expect(after[0]!.caloriesPer100g).toBe(100);
  });
});

describe('foods', () => {
  it('searches catalog and user foods together', async () => {
    const repo = await makeRepo();
    await repo.createUserFood({ name: 'Protein Bar X', caloriesPer100g: 380, servings: [{ id: 'g', label: 'g', grams: 1, approx: false }] }, 'u1');
    const hits = await repo.searchFoods('protein');
    expect(hits.some((f) => f.name === 'Protein Bar X')).toBe(true);
    const all = await repo.searchFoods('', 1000);
    expect(all.some((f) => f.source === 'user')).toBe(true);
    expect(all.some((f) => f.source === 'catalog')).toBe(true);
  });

  it('user foods are editable/deletable; catalog foods are not', async () => {
    const repo = await makeRepo();
    const b = await broccoli(repo);
    await expect(repo.updateUserFood(b.id, { name: 'x', caloriesPer100g: 1, servings: [] })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.deleteUserFood(b.id)).rejects.toBeInstanceOf(ValidationError);

    const food = await repo.createUserFood({ name: 'Salsa Verde', caloriesPer100g: 30, servings: [{ id: 'g', label: 'g', grams: 1, approx: false }] }, 'u1');
    await repo.updateUserFood(food.id, { name: 'Salsa Verde 2', caloriesPer100g: 35, servings: [{ id: 'g', label: 'g', grams: 1, approx: false }] });
    expect((await repo.getUserFoods())[0]!.name).toBe('Salsa Verde 2');
    await repo.deleteUserFood(food.id);
    expect(await repo.getUserFoods()).toEqual([]);
    expect((await repo.searchFoods('salsa verde')).length).toBe(0);
  });

  it('validates custom food input', async () => {
    const repo = await makeRepo();
    await expect(repo.createUserFood({ name: '', caloriesPer100g: 10, servings: [{ id: 'g', label: 'g', grams: 1, approx: false }] }, 'u1')).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.createUserFood({ name: 'X', caloriesPer100g: -5, servings: [{ id: 'g', label: 'g', grams: 1, approx: false }] }, 'u1')).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.createUserFood({ name: 'X', caloriesPer100g: 10, servings: [] }, 'u1')).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.createUserFood({ name: 'X', caloriesPer100g: 10, servings: [{ id: 'g', label: 'g', grams: 0, approx: false }] }, 'u1')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('health measurements', () => {
  it('adds, ranges, edits, and tombstones measurements', async () => {
    const repo = await makeRepo();
    const m = await repo.addHealthMeasurement({ measuredAt: '2026-08-15', weightKg: 70.5, heightCm: null });
    await repo.addHealthMeasurement({ measuredAt: '2026-08-01', weightKg: 71, heightCm: 175 });
    const inRange = await repo.getHealthMeasurements('2026-08-10', '2026-08-20');
    expect(inRange.map((x) => x.measuredAt)).toEqual(['2026-08-15']);
    const all = await repo.getHealthMeasurements();
    expect(all.length).toBe(2);

    await repo.updateHealthMeasurement(m.id, { measuredAt: '2026-08-16', weightKg: 70.2, heightCm: 175 });
    expect((await repo.getHealthMeasurements('2026-08-16', '2026-08-16'))[0]!.weightKg).toBe(70.2);

    await repo.deleteHealthMeasurement(m.id);
    expect((await repo.getHealthMeasurements('2026-08-16', '2026-08-16')).length).toBe(0);
    const rows = await repo.listForSync('health_measurements');
    expect(rows.filter((r) => r.id === m.id)[0]!.deletedAt).not.toBeNull();
  });

  it('validates measurements', async () => {
    const repo = await makeRepo();
    await expect(repo.addHealthMeasurement({ measuredAt: 'bad', weightKg: 70, heightCm: null })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.addHealthMeasurement({ measuredAt: '2026-08-15', weightKg: -1, heightCm: null })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.addHealthMeasurement({ measuredAt: '2026-08-15', weightKg: NaN, heightCm: null })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.addHealthMeasurement({ measuredAt: '2026-08-15', weightKg: null, heightCm: null })).rejects.toBeInstanceOf(ValidationError);
  });

  it('returns the latest measurement at or before a date', async () => {
    const repo = await makeRepo();
    await repo.addHealthMeasurement({ measuredAt: '2026-08-01', weightKg: 72, heightCm: null });
    await repo.addHealthMeasurement({ measuredAt: '2026-08-10', weightKg: 71, heightCm: null });
    const latest = await repo.getLatestHealthBefore('2026-08-09');
    expect(latest?.weightKg).toBe(72);
    expect((await repo.getLatestHealthBefore('2026-07-31'))).toBeNull();
  });
});

describe('daily summaries', () => {
  it('aggregates intake and joins the latest measurement at/before each date', async () => {
    const repo = await makeRepo();
    const b = await broccoli(repo); // 24 kcal/cup
    await repo.addEntry({ logDate: '2026-08-10', foodId: b.id, servingId: 'sv-cup', amount: 1 });
    await repo.addEntry({ logDate: '2026-08-10', foodId: b.id, servingId: 'sv-cup', amount: 1 });
    await repo.addHealthMeasurement({ measuredAt: '2026-08-11', weightKg: 70, heightCm: 175 });
    await repo.addEntry({ logDate: '2026-08-12', foodId: b.id, servingId: 'sv-cup', amount: 1 });

    const summaries = await repo.getDailySummaries('2026-08-10', '2026-08-13');
    expect(summaries.map((s) => s.logDate)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']);
    expect(summaries[0]).toMatchObject({ logDate: '2026-08-10', calories: 48, entryCount: 2, weightKg: null });
    expect(summaries[1]).toMatchObject({ logDate: '2026-08-11', calories: 0, entryCount: 0, weightKg: 70 });
    expect(summaries[2]).toMatchObject({ logDate: '2026-08-12', calories: 24, entryCount: 1, weightKg: 70 });
    // the latest measurement at-or-before a date carries forward (per summary contract)
    expect(summaries[3]).toMatchObject({ logDate: '2026-08-13', calories: 0, entryCount: 0, weightKg: 70 });
    // dates before any data are absent entirely — charts render those as gaps
    expect((await repo.getDailySummaries('2026-08-01', '2026-08-09')).length).toBe(0);
  });

  it('deleted entries and measurements stop contributing', async () => {
    const repo = await makeRepo();
    const b = await broccoli(repo);
    const e = await repo.addEntry({ logDate: '2026-08-10', foodId: b.id, servingId: 'sv-cup', amount: 1 });
    const m = await repo.addHealthMeasurement({ measuredAt: '2026-08-10', weightKg: 70, heightCm: null });
    await repo.deleteEntry(e.id);
    await repo.deleteHealthMeasurement(m.id);
    expect(await repo.getDailySummaries('2026-08-10', '2026-08-10')).toEqual([]);
  });
});

describe('sync queue and remote application', () => {
  it('queues every write and clears only after markSynced', async () => {
    const repo = await makeRepo();
    const b = await broccoli(repo);
    const e = await repo.addEntry({ logDate: '2026-08-17', foodId: b.id, servingId: 'sv-cup', amount: 1 });
    let queue = await repo.getUnsyncedChanges();
    expect(queue.length).toBe(1);
    expect(queue[0]).toMatchObject({ id: e.id, table: 'daily_entries', op: 'upsert' });
    await repo.markSynced([e.id]);
    expect(await repo.getUnsyncedChanges()).toEqual([]);
  });

  it('applies remote rows with newest-updatedAt-wins', async () => {
    const repo = await makeRepo();
    const b = await broccoli(repo);
    const e = await repo.addEntry({ logDate: '2026-08-17', foodId: b.id, servingId: 'sv-cup', amount: 1 });

    const newer = { ...e, calories: 999, updatedAt: '2099-01-01T00:00:00.000Z' };
    expect(await repo.applyRemote('daily_entries', [newer])).toBe(1);
    expect((await repo.getDailyEntries('2026-08-17'))[0]!.calories).toBe(999);

    const older = { ...e, calories: 1, updatedAt: '2000-01-01T00:00:00.000Z' };
    expect(await repo.applyRemote('daily_entries', [older])).toBe(0);
    expect((await repo.getDailyEntries('2026-08-17'))[0]!.calories).toBe(999);
  });

  it('propagates remote tombstones (deletes win over local copies)', async () => {
    const repo = await makeRepo();
    const b = await broccoli(repo);
    const e = await repo.addEntry({ logDate: '2026-08-17', foodId: b.id, servingId: 'sv-cup', amount: 1 });
    const remoteTombstone = { ...e, deletedAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' };
    await repo.applyRemote('daily_entries', [remoteTombstone]);
    expect(await repo.getDailyEntries('2026-08-17')).toEqual([]);
    const rows = await repo.listForSync('daily_entries');
    expect(rows[0]!.deletedAt).toBe('2099-01-01T00:00:00.000Z');
  });
});

describe('backup export / import', () => {
  it('round-trips user data through a backup payload', async () => {
    const repo = await makeRepo();
    const b = await broccoli(repo);
    const food = await repo.createUserFood({ name: 'Homemade Oatmeal', caloriesPer100g: 150, servings: [{ id: 'g', label: 'g', grams: 1, approx: false }] }, 'u1');
    const e = await repo.addEntry({ logDate: '2026-08-17', foodId: b.id, servingId: 'sv-cup', amount: 2 });
    const m = await repo.addHealthMeasurement({ measuredAt: '2026-08-17', weightKg: 70, heightCm: null });

    const backup = await repo.exportBackup();
    expect(backup.userFoods.map((f) => f.name)).toEqual(['Homemade Oatmeal']);
    expect(backup.entries.map((x) => x.id)).toEqual([e.id]);
    expect(backup.measurements.map((x) => x.id)).toEqual([m.id]);
    expect(backup.app).toBe('calorie-counter');

    // merge into a fresh database
    const repo2 = await makeRepo();
    await repo2.importBackup(backup, { restore: false });
    expect((await repo2.getUserFoods()).length).toBe(1);
    expect((await repo2.getDailyEntries('2026-08-17')).length).toBe(1);
    expect((await repo2.getHealthMeasurements()).length).toBe(1);
    // imported rows are queued for sync
    expect((await repo2.getUnsyncedChanges()).length).toBe(3);
    // catalog untouched
    expect((await repo2.searchFoods('broccoli')).length).toBeGreaterThan(0);
  });

  it('merge keeps the newest version of a conflicting record', async () => {
    const repo = await makeRepo();
    const b = await broccoli(repo);
    const e = await repo.addEntry({ logDate: '2026-08-17', foodId: b.id, servingId: 'sv-cup', amount: 1 });
    const backup = await repo.exportBackup();
    backup.entries[0]!.updatedAt = '2000-01-01T00:00:00.000Z'; // stale remote copy
    // local edits get newer
    await repo.updateEntry(e.id, { amount: 3 });
    await repo.importBackup(backup, { restore: false });
    const after = await repo.getDailyEntries('2026-08-17');
    expect(after[0]!.amount).toBe(3); // local (newer) wins
  });

  it('restore replaces local user data but never the catalog', async () => {
    const repo = await makeRepo();
    const b = await broccoli(repo);
    await repo.addEntry({ logDate: '2026-08-17', foodId: b.id, servingId: 'sv-cup', amount: 1 });
    const backup = await repo.exportBackup();
    await repo.addEntry({ logDate: '2026-08-18', foodId: b.id, servingId: 'sv-cup', amount: 1 }); // extra local row
    await repo.importBackup(backup, { restore: true });
    expect(await repo.getDailyEntries('2026-08-18')).toEqual([]); // replaced
    expect((await repo.getDailyEntries('2026-08-17')).length).toBe(1);
    expect((await repo.searchFoods('broccoli')).length).toBeGreaterThan(0); // catalog intact
  });

  it('rejects malformed payloads', async () => {
    const repo = await makeRepo();
    await expect(repo.importBackup({ app: 'other' }, { restore: false })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.importBackup(null, { restore: false })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.importBackup({ app: 'calorie-counter', userFoods: [{ bad: true }], entries: [], measurements: [] }, { restore: false })).rejects.toBeInstanceOf(ValidationError);
  });
});
