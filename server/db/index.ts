import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function openDb(dbFile: string): Database.Database {
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  const schema = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), 'schema.sql'),
    'utf8',
  );
  db.exec(schema);

  // Existing databases predate later stages: CREATE TABLE IF NOT EXISTS does
  // not add new columns, so migrate them explicitly and only once.
  const characterColumns = new Set(
    (db.prepare("PRAGMA table_info('characters')").all() as { name: string }[]).map((c) => c.name),
  );
  if (!characterColumns.has('last_rest_at')) {
    db.exec('ALTER TABLE characters ADD COLUMN last_rest_at TEXT NULL');
  }

  const columns = new Set(
    (db.prepare("PRAGMA table_info('battle_sessions')").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (!columns.has('synced_at')) {
    db.exec('ALTER TABLE battle_sessions ADD COLUMN synced_at TEXT NULL');
  }
  if (!columns.has('rewards_json')) {
    db.exec('ALTER TABLE battle_sessions ADD COLUMN rewards_json TEXT NULL');
  }
  return db;
}
