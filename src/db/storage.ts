/**
 * Storage adapter contract. The repository layer sits on top and never sees
 * SQL or IndexedDB — screens call only repository methods.
 *
 * The adapters are untyped at runtime (rows are JSON records), so every method
 * is generic over the caller's row type and defaults to `Row`. A caller that
 * knows the table's shape asks for it — `db.get<Food>('foods', id)` — and the
 * typed read replaces what used to be a cast at the call site.
 */
export type Row = Record<string, unknown>;

export interface Query<T = Row> {
  /** Field name (must be indexed in TABLES). Omit to scan the table. */
  index?: string;
  /** Inclusive lower bound (undefined = unbounded). */
  lower?: unknown;
  /** Inclusive upper bound (undefined = unbounded). */
  upper?: unknown;
  direction?: 'asc' | 'desc';
  limit?: number;
  /** Applied after the index fetch (personal-scale tables). */
  filter?: (row: T) => boolean;
}

/** Widen a caller-owned domain object into the record the adapters persist. */
export function toRow<T extends object>(value: T): Row {
  return { ...value } as Row;
}

export interface StorageAdapter {
  readonly kind: 'sqlite' | 'indexeddb';
  /** Open/create the store and ensure schema. Idempotent. */
  init(): Promise<void>;
  get<T = Row>(table: string, id: string): Promise<T | null>;
  /** Upsert by `id`. */
  put<T extends object = Row>(table: string, row: T): Promise<void>;
  bulkPut<T extends object = Row>(table: string, rows: T[]): Promise<void>;
  /** Physical delete (used to clear queue rows and full restore). */
  remove(table: string, id: string): Promise<void>;
  query<T = Row>(table: string, q?: Query<T>): Promise<T[]>;
  count(table: string): Promise<number>;
  clear(table: string): Promise<void>;
}
