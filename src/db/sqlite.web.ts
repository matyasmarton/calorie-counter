/**
 * SQLite adapter for web — never used. Web storage is IndexedDB (see
 * indexeddb.ts); this stub exists so the platform-resolved import in db.ts
 * never pulls expo-sqlite (and its experimental WASM worker) into the web
 * bundle. Metro picks this file for Platform.OS === 'web'.
 */
import type { Query, Row, StorageAdapter } from './storage';

function unavailable(): never {
  throw new Error('SQLite storage is not available on web; use the IndexedDB adapter');
}

export class SqliteStorage implements StorageAdapter {
  readonly kind = 'sqlite' as const;
  init(): Promise<void> {
    return Promise.reject(unavailable());
  }
  get<T = Row>(): Promise<T | null> {
    return Promise.reject(unavailable());
  }
  put<T extends object = Row>(): Promise<void> {
    return Promise.reject(unavailable());
  }
  bulkPut<T extends object = Row>(): Promise<void> {
    return Promise.reject(unavailable());
  }
  remove(): Promise<void> {
    return Promise.reject(unavailable());
  }
  query<T = Row>(_table: string, _q?: Query<T>): Promise<T[]> {
    return Promise.reject(unavailable());
  }
  count(): Promise<number> {
    return Promise.reject(unavailable());
  }
  clear(): Promise<void> {
    return Promise.reject(unavailable());
  }
}
