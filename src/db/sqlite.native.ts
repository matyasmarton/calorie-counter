/**
 * SQLite storage adapter — used on Android via expo-sqlite.
 * Rows live in a JSON column (`json`) plus one scalar column per indexed
 * field, so repository queries map to real SQL and real indexes.
 */
import * as SQLite from 'expo-sqlite';
import { TABLES } from './schema';
import { toRow, type Query, type Row, type StorageAdapter } from './storage';

export class SqliteStorage implements StorageAdapter {
  readonly kind = 'sqlite' as const;
  private db: SQLite.SQLiteDatabase | null = null;

  async init(): Promise<void> {
    if (this.db) return;
    this.db = await SQLite.openDatabaseAsync('calorie-counter.db');
    const db = this.db;
    for (const spec of Object.values(TABLES)) {
      const indexCols = spec.indexes.map((f) => `"${f}" TEXT`).join(', ');
      await db.execAsync(
        `CREATE TABLE IF NOT EXISTS "${spec.name}" (
           id TEXT PRIMARY KEY NOT NULL,
           json TEXT NOT NULL
           ${indexCols ? `, ${indexCols}` : ''}
         );`,
      );
      for (const f of spec.indexes) {
        await db.execAsync(
          `CREATE INDEX IF NOT EXISTS "idx_${spec.name}_${f}" ON "${spec.name}" ("${f}");`,
        );
      }
      for (const fields of spec.composite) {
        const name = fields.join('_');
        await db.execAsync(
          `CREATE INDEX IF NOT EXISTS "idx_${spec.name}_${name}" ON "${spec.name}" (${fields
            .map((f) => `"${f}"`)
            .join(', ')});`,
        );
      }
    }
  }

  private getDb(): SQLite.SQLiteDatabase {
    if (!this.db) throw new Error('SqliteStorage not initialized');
    return this.db;
  }

  private exec(sql: string, params: (string | number | null)[] = []): Promise<import('expo-sqlite').SQLiteRunResult> {
    return this.getDb().runAsync(sql, ...params);
  }

  async get<T = Row>(table: string, id: string): Promise<T | null> {
    const rows = await this.getDb().getAllAsync<{ json: string }>(
      `SELECT json FROM "${table}" WHERE id = ?`,
      [id],
    );
    const row = rows[0];
    return row ? (JSON.parse(row.json) as T) : null;
  }

  async put<T extends object = Row>(table: string, row: T): Promise<void> {
    const spec = TABLES[table];
    if (!spec) throw new Error(`unknown table: ${table}`);
    // Storage records are plain JSON objects; index columns read off the same
    // row the adapter is about to serialize.
    const record = toRow(row);
    const cols = ['id', 'json', ...spec.indexes];
    const values = [
      String(record.id),
      JSON.stringify(record),
      ...spec.indexes.map((f) => (record[f] == null ? null : String(record[f]))),
    ];
    const placeholders = cols.map(() => '?').join(', ');
    await this.exec(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')})
       VALUES (${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${spec.indexes
         .map((f) => `"${f}" = excluded."${f}"`)
         .concat('json = excluded.json')
         .join(', ')}`,
      values,
    );
  }

  async bulkPut<T extends object = Row>(table: string, rows: T[]): Promise<void> {
    const db = this.getDb();
    await db.withTransactionAsync(async () => {
      for (const row of rows) await this.put(table, row);
    });
  }

  async remove(table: string, id: string): Promise<void> {
    await this.exec(`DELETE FROM "${table}" WHERE id = ?`, [id]);
  }

  async query<T = Row>(table: string, q: Query<T> = {}): Promise<T[]> {
    const spec = TABLES[table];
    if (!spec) throw new Error(`unknown table: ${table}`);
    const where: string[] = [];
    const params: string[] = [];
    let orderCol = 'id';
    if (q.index) {
      if (!spec.indexes.includes(q.index)) {
        throw new Error(`unknown index ${q.index} on ${table}`);
      }
      orderCol = q.index;
      if (q.lower !== undefined) {
        where.push(`"${q.index}" >= ?`);
        params.push(String(q.lower));
      }
      if (q.upper !== undefined) {
        where.push(`"${q.index}" <= ?`);
        params.push(String(q.upper));
      }
    }
    const sql = `SELECT json FROM "${table}" ${
      where.length ? `WHERE ${where.join(' AND ')}` : ''
    } ORDER BY "${orderCol}" ${q.direction === 'desc' ? 'DESC' : 'ASC'}`;
    const rows = await this.getDb().getAllAsync<{ json: string }>(sql, ...params);
    let out = rows.map((r) => JSON.parse(r.json) as T);
    if (q.filter) out = out.filter(q.filter);
    if (q.limit && out.length > q.limit) out = out.slice(0, q.limit);
    return out;
  }

  async count(table: string): Promise<number> {
    const rows = await this.getDb().getAllAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM "${table}"`,
    );
    return rows[0]?.n ?? 0;
  }

  async clear(table: string): Promise<void> {
    await this.exec(`DELETE FROM "${table}"`);
  }
}
