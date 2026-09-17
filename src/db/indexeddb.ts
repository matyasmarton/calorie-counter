/**
 * IndexedDB storage adapter — used on web and in unit tests (fake-indexeddb).
 * Object stores are keyed by `id`; each table's indexes are created on init.
 */
import { TABLES } from './schema';
import type { Query, Row, StorageAdapter } from './storage';

const DB_NAME = 'calorie-counter';
// Bump when TABLES gains or changes stores: onupgradeneeded only fires on a
// version change, so existing installs would otherwise keep the old store set
// (e.g. a pre-saved_recipes database silently lacks that store).
const DB_VERSION = 3;

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
    // A version-change upgrade is blocked while another tab holds the old
    // connection; retry briefly instead of hanging the app forever.
    req.onblocked = () => {
      const req2 = indexedDB.open(DB_NAME, DB_VERSION);
      setTimeout(() => {
        req2.onupgradeneeded = req.onupgradeneeded;
        req2.onsuccess = req.onsuccess;
        req2.onerror = req.onerror;
        req2.onblocked = () => reject(new Error('indexedDB upgrade blocked by another open tab'));
      }, 500);
    };
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

  async get<T = Row>(table: string, id: string): Promise<T | null> {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(table, 'readonly');
      const req = this.store(tx, table).get(id);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async put<T extends object = Row>(table: string, row: T): Promise<void> {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(table, 'readwrite');
      tx.objectStore(table).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async bulkPut<T extends object = Row>(table: string, rows: T[]): Promise<void> {
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

  async query<T = Row>(table: string, q: Query<T> = {}): Promise<T[]> {
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
      const out: T[] = [];
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          // IndexedDB stores the JSON record we wrote; the cursor value is the
          // caller's row type by construction of the table.
          const row = cursor.value as T;
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
