import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  account TEXT,
  cents INTEGER,
  memo TEXT,
  at TEXT
)`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
