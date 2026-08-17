/**
 * Storage adapter contract. The repository layer sits on top and never sees
 * SQL or IndexedDB — screens call only repository methods.
 */
export type Row = Record<string, unknown>;

export interface Query {
  /** Field name (must be indexed in TABLES). Omit to scan the table. */
  index?: string;
  /** Inclusive lower bound (undefined = unbounded). */
  lower?: unknown;
  /** Inclusive upper bound (undefined = unbounded). */
  upper?: unknown;
  direction?: 'asc' | 'desc';
  limit?: number;
  /** Applied after the index fetch (personal-scale tables). */
  filter?: (row: Row) => boolean;
}

export interface StorageAdapter {
  readonly kind: 'sqlite' | 'indexeddb';
  /** Open/create the store and ensure schema. Idempotent. */
  init(): Promise<void>;
  get(table: string, id: string): Promise<Row | null>;
  /** Upsert by `id`. */
  put(table: string, row: Row): Promise<void>;
  bulkPut(table: string, rows: Row[]): Promise<void>;
  /** Physical delete (used to clear queue rows and full restore). */
  remove(table: string, id: string): Promise<void>;
  query(table: string, q?: Query): Promise<Row[]>;
  count(table: string): Promise<number>;
  clear(table: string): Promise<void>;
}
