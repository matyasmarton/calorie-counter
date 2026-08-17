/**
 * Idempotent default-catalog import.
 * - Seeds `foods` (source = "catalog") from the checked-in data/foods.json.
 * - Records provenance/version in catalog_metadata; a matching version skips
 *   the import entirely (so re-launches and app updates do nothing).
 * - A version change replaces catalog rows wholesale — user-created rows
 *   (source = "user") are never touched, and entries snapshot their own
 *   nutrient values so historical logs are unaffected.
 */
import type { CatalogMetadata, Food } from '@/domain/types';
import type { Row, StorageAdapter } from './storage';

export interface CatalogBundle {
  metadata: {
    sourceName: string;
    sourceUrl: string;
    version: string;
    license: string;
    foodCount: number;
    notes: string;
  };
  foods: Food[];
}

export const CATALOG_VERSION_KEY = 'default';

export async function seedCatalog(db: StorageAdapter, bundle: CatalogBundle): Promise<void> {
  const existing = await db.get('catalog_metadata', CATALOG_VERSION_KEY);
  const meta = existing as CatalogMetadata | null;
  if (meta && meta.version === bundle.metadata.version) {
    return; // already imported at this version — idempotent skip
  }

  const now = new Date().toISOString();
  const stamp = (food: Food): Food => ({ ...food, createdAt: now, updatedAt: now });

  const oldFoods = (await db.query('foods', {
    index: 'source',
    lower: 'catalog',
    upper: 'catalog',
  })) as unknown as Food[];
  const newIds = new Set(bundle.foods.map((f) => f.id));
  // Tombstone catalog rows removed from the new bundle (entries keep snapshots).
  const removed = oldFoods.filter((f) => !newIds.has(f.id)).map((f) => ({ ...f, deletedAt: now }));

  await db.bulkPut('foods', [...bundle.foods.map(stamp), ...removed] as unknown as Row[]);
  const catalogMeta: CatalogMetadata = {
    id: CATALOG_VERSION_KEY,
    sourceName: bundle.metadata.sourceName,
    sourceUrl: bundle.metadata.sourceUrl,
    version: bundle.metadata.version,
    license: bundle.metadata.license,
    foodCount: bundle.foods.length,
    importedAt: now,
    notes: bundle.metadata.notes,
  };
  await db.put('catalog_metadata', catalogMeta as unknown as Row);
}
