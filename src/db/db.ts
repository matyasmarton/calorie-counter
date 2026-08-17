/**
 * Adapter factory: SQLite on native (Android), IndexedDB on web.
 * The repository contract is identical on both platforms.
 */
import { Platform } from 'react-native';
import { IndexedDbStorage } from './indexeddb';
import { SqliteStorage } from './sqlite';
import type { StorageAdapter } from './storage';

export function createStorage(): StorageAdapter {
  return Platform.OS === 'web' ? new IndexedDbStorage() : new SqliteStorage();
}
