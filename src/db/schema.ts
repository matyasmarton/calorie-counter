/**
 * Logical database schema — the single source of truth for both storage
 * adapters (IndexedDB on web/tests, SQLite on Android).
 *
 * All rows are stored as JSON objects keyed by `id` (UUID). Adapters index
 * the listed fields so repository queries stay small; ordering/aggregation
 * happens in the repository layer (row counts are personal-scale).
 */
export interface TableSpec {
  name: string;
  /** Single-field indexes: field name -> real index in both adapters. */
  indexes: string[];
  /**
   * Composite indexes, created in SQLite DDL (and mirrored as IDB composite
   * indexes where cheap). Serves `WHERE log_date = ? ORDER BY updated_at`
   * and pull-by-cursor scans.
   */
  composite: string[][];
}

export const TABLES: Record<string, TableSpec> = {
  foods: {
    name: 'foods',
    indexes: ['name', 'source', 'updatedAt'],
    composite: [['name', 'updatedAt']],
  },
  daily_entries: {
    name: 'daily_entries',
    indexes: ['logDate', 'updatedAt'],
    composite: [['logDate', 'updatedAt']],
  },
  health_measurements: {
    name: 'health_measurements',
    indexes: ['measuredAt', 'updatedAt'],
    composite: [['measuredAt', 'updatedAt']],
  },
  saved_recipes: {
    name: 'saved_recipes',
    indexes: ['name', 'updatedAt'],
    composite: [['name', 'updatedAt']],
  },
  sync_queue: {
    name: 'sync_queue',
    indexes: ['pushedAt', 'updatedAt'],
    composite: [],
  },
  catalog_metadata: {
    name: 'catalog_metadata',
    indexes: [],
    composite: [],
  },
  sync_meta: {
    name: 'sync_meta',
    indexes: [],
    composite: [],
  },
};

export const TABLE_NAMES = Object.keys(TABLES);
