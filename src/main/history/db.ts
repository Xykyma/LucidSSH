import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../config/store';
import { purgeHistoryBackups, writeDbBackup } from './backups';

/**
 * history.db — история команд и сниппеты (Data_Structures §3–4).
 * Отдельный файл от hosts.db, чтобы очистка/отключение истории не затрагивала
 * хосты. Все запросы параметризованы; секреты в command УЖЕ замаскированы (HIST-07).
 */

let db: Database.Database | null = null;

/** Стирание сохранённого вывода (HIST-09, Data_Structures §3.5); has_secret не трогаем. */
export const ERASE_OUTPUT_SQL = 'UPDATE history SET output = NULL, output_truncated = 0;';

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
  `,
  // v5 — HIST-09: вывод команд теперь opt-in; вывод, накопленный прежними
  // версиями (писались всегда), стирается. Копии history.db и checkpoint WAL —
  // после транзакции, в openHistoryDb (PRAGMA wal_checkpoint в транзакции нельзя).
  ERASE_OUTPUT_SQL
];

/** Номер миграции, стирающей вывод (v5): копии БД версий ниже содержат его. */
const ERASE_OUTPUT_VERSION = 5;

export function historyDbPath(): string {
  return join(configDir(), 'history.db');
}

export function openHistoryDb(): Database.Database {
  if (db) return db;
  mkdirSync(configDir(), { recursive: true });
  const path = historyDbPath();
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('secure_delete = ON'); // HIST-08: страницы, освобождённые дальше, затираются (единственный VACUUM — в миграции v5, для страниц до secure_delete)

  const current = db.pragma('user_version', { simple: true }) as number;
  if (current < MIGRATIONS.length) {
    if (current > 0 && existsSync(path)) {
      writeDbBackup(path, current); // UPD-04
    }
    const migrate = db.transaction(() => {
      for (let v = current; v < MIGRATIONS.length; v++) db!.exec(MIGRATIONS[v]!);
      db!.pragma(`user_version = ${MIGRATIONS.length}`);
    });
    migrate();
    // v5 стёрла вывод: копии, включая только что сделанную, хранят его же
    if (current > 0 && current < ERASE_OUTPUT_VERSION) {
      // secure_delete затирает лишь страницы, освобождённые после его включения;
      // вывод строк, удалённых в ≤1.0.2, лежит в свободных страницах — один раз
      // чистим VACUUM-ом (вне транзакции). Сбой не валит запуск: v5 уже закоммичена.
      try {
        db.exec('VACUUM');
      } catch (e) {
        console.error('history.db: VACUUM после миграции v5 не удался', e);
      }
      purgeHistoryTraces(db);
    }
  }
  return db;
}

/**
 * После удаления из истории по действию пользователя (HIST-08/09): WAL
 * схлопывается в файл БД, копии history.db удаляются целиком. FIFO-вытеснение
 * (HIST-06) и выключатели истории сюда не приходят.
 */
export function purgeHistoryTraces(d: Database.Database = openHistoryDb()): void {
  d.pragma('wal_checkpoint(TRUNCATE)');
  purgeHistoryBackups(historyDbPath());
}

export function closeHistoryDb(): void {
  db?.close();
  db = null;
}
