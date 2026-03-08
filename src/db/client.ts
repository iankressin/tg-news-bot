import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema.js';

export type AppDatabase = ReturnType<typeof createDb>;

export function createDb(url: string) {
  const sqlite = new Database(url);
  sqlite.pragma('journal_mode = WAL');
  return drizzle(sqlite, { schema });
}
