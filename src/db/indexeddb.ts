/**
 * IndexedDB storage adapter — used on web and in unit tests (fake-indexeddb).
 * Object stores are keyed by `id`; each table's indexes are created on init.
 */
import { TABLES } from './schema';
import type { Query, Row, StorageAdapter } from './storage';

const DB_NAME = 'calorie-counter';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const spec of Object.values(TABLES)) {
        if (!db.objectStoreNames.contains(spec.name)) {
          const store = db.createObjectStore(spec.name, { keyPath: 'id' });
          for (const field of spec.indexes) {
            store.createIndex(field, field, { unique: false });
          }
          for (const fields of spec.composite) {
            store.createIndex(fields.join('+'), fields, { unique: false });
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

export class IndexedDbStorage implements StorageAdapter {
  readonly kind = 'indexeddb' as const;
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    if (this.db) return;
    this.db = await openDb();
  }

  private store(tx: IDBTransaction, table: string): IDBObjectStore {
    return tx.objectStore(table);
  }

  async get(table: string, id: string): Promise<Row | null> {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(table, 'readonly');
      const req = this.store(tx, table).get(id);
      req.onsuccess = () => resolve((req.result as Row) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async put(table: string, row: Row): Promise<void> {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(table, 'readwrite');
      tx.objectStore(table).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async bulkPut(table: string, rows: Row[]): Promise<void> {
    await this.init();
    if (rows.length === 0) return;
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(table, 'readwrite');
      const store = tx.objectStore(table);
      for (const row of rows) store.put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async remove(table: string, id: string): Promise<void> {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(table, 'readwrite');
      tx.objectStore(table).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async query(table: string, q: Query = {}): Promise<Row[]> {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(table, 'readonly');
      const store = this.store(tx, table);
      let source: IDBRequest | IDBObjectStore | IDBIndex = store;
      let keyRange: IDBKeyRange | undefined;
      if (q.index) {
        const idx = store.index(q.index);
        source = idx;
        if (q.lower !== undefined && q.upper !== undefined) {
          keyRange = IDBKeyRange.bound(q.lower as never, q.upper as never);
        } else if (q.lower !== undefined) {
          keyRange = IDBKeyRange.lowerBound(q.lower as never);
        } else if (q.upper !== undefined) {
          keyRange = IDBKeyRange.upperBound(q.upper as never);
        }
      } else if (q.lower !== undefined || q.upper !== undefined) {
        // range without an index: primary-key range
        if (q.lower !== undefined && q.upper !== undefined) {
          keyRange = IDBKeyRange.bound(q.lower as never, q.upper as never);
        } else if (q.lower !== undefined) {
          keyRange = IDBKeyRange.lowerBound(q.lower as never);
        } else {
          keyRange = IDBKeyRange.upperBound(q.upper as never);
        }
      }
      const req = source.openCursor(keyRange, q.direction === 'desc' ? 'prev' : 'next');
      const out: Row[] = [];
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const row = cursor.value as Row;
          if (!q.filter || q.filter(row)) out.push(row);
          if (q.limit && out.length >= q.limit) {
            resolve(out);
            return;
          }
          cursor.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async count(table: string): Promise<number> {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(table, 'readonly');
      const req = tx.objectStore(table).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async clear(table: string): Promise<void> {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(table, 'readwrite');
      tx.objectStore(table).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
