import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../config/store';

/**
 * history.db — история команд и сниппеты (Data_Structures §3–4).
 * Отдельный файл от hosts.db, чтобы очистка/отключение истории не затрагивала
 * хосты. Все запросы параметризованы; секреты в command УЖЕ замаскированы (HIST-07).
 */

let db: Database.Database | null = null;

const MIGRATIONS: string[] = [
  // v1 — история + сниппеты
  `
  CREATE TABLE IF NOT EXISTS history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    command      TEXT    NOT NULL,
    host_id      INTEGER,
    host_name    TEXT    NOT NULL,
    username     TEXT    NOT NULL,
    started_at   TEXT    NOT NULL,
    finished_at  TEXT,
    exit_code    INTEGER,
    guard_status TEXT,
    has_secret   INTEGER NOT NULL DEFAULT 0,
    is_favorite  INTEGER NOT NULL DEFAULT 0,
    note         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_history_command ON history(command);
  CREATE INDEX IF NOT EXISTS idx_history_host    ON history(host_id);
  CREATE INDEX IF NOT EXISTS idx_history_time    ON history(started_at);

  CREATE TABLE IF NOT EXISTS snippets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    command     TEXT    NOT NULL,
    description TEXT,
    host_id     INTEGER,
    danger      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_snippets_host   ON snippets(host_id);
  CREATE INDEX IF NOT EXISTS idx_snippets_danger ON snippets(danger);
  `,
  // v2 — вывод команды в истории (разворачивание по клику, замаскированный
  // и усечённый в repository.ts перед записью; см. Ideas_Backlog.md)
  `
  ALTER TABLE history ADD COLUMN output TEXT;
  ALTER TABLE history ADD COLUMN output_truncated INTEGER NOT NULL DEFAULT 0;
  `,
  // v3 — ручной порядок сниппетов (SNIP-10), раздельно для серверных/глобальных
  `
  ALTER TABLE snippets ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
  `,
  // v4 — пометка «сохранена как сниппет» в listHistory (SNIP-12): подзапросы
  // по (command, host_id) на каждой странице истории — без индекса это полный
  // скан snippets на каждую строку history.
  `
  CREATE INDEX IF NOT EXISTS idx_snippets_command ON snippets(command, host_id);
  `
];

export function historyDbPath(): string {
  return join(configDir(), 'history.db');
}

export function openHistoryDb(): Database.Database {
  if (db) return db;
  mkdirSync(configDir(), { recursive: true });
  const path = historyDbPath();
  db = new Database(path);
  db.pragma('journal_mode = WAL');

  const current = db.pragma('user_version', { simple: true }) as number;
  if (current < MIGRATIONS.length) {
    if (current > 0 && existsSync(path)) {
      copyFileSync(path, `${path}.backup-v${current}`); // UPD-04
    }
    const migrate = db.transaction(() => {
      for (let v = current; v < MIGRATIONS.length; v++) db!.exec(MIGRATIONS[v]!);
      db!.pragma(`user_version = ${MIGRATIONS.length}`);
    });
    migrate();
  }
  return db;
}

export function closeHistoryDb(): void {
  db?.close();
  db = null;
}
