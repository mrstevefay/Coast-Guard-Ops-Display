import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncT, SQLInputValue } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';

// Loaded via getBuiltinModule so bundlers/test runners (Vite) that don't know
// the `node:sqlite` builtin yet don't try to resolve it from disk.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncT;

export type Row = Record<string, SQLInputValue | null | undefined>;

/**
 * Thin wrapper around node:sqlite (built into Node >= 22.13, no native deps).
 * One connection per process; SQLite serialises writes for us.
 */
export class Db {
  readonly raw: DatabaseSync;

  constructor(readonly file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
    `);
  }

  /** Apply pending migrations; returns the number applied. */
  migrate(): number {
    const current = (this.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    let applied = 0;
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(MIGRATIONS[i]);
        this.raw.exec(`PRAGMA user_version = ${i + 1}`);
        this.raw.exec('COMMIT');
        applied++;
      } catch (e) {
        this.raw.exec('ROLLBACK');
        throw new Error(`migration ${i + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return applied;
  }

  get version(): number {
    return (this.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  /** Run fn inside a transaction (nested calls reuse the outer one). */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.inTx = true;
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.inTx = false;
    }
  }
  private inTx = false;

  close(): void {
    this.raw.close();
  }
}

export function openDb(file: string): Db {
  const db = new Db(file);
  db.migrate();
  return db;
}

export const now = () => new Date().toISOString();
