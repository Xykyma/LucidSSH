import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DASHBOARD_ALERT_ISSUES } from '@shared/dashboard';
import { configDir } from '../config/store';
import { resolveHostRefByName } from './resolveByName';

/**
 * hosts.db — SQLite-хранилище хостов и групп (Data_Structures.md §2).
 * Все запросы параметризованы; конкатенация значений в SQL запрещена (§18 гайда).
 * Перед необратимой миграцией создаётся резервная копия файла (UPD-04).
 */

let db: Database.Database | null = null;

type MigrationStep = string | ((db: Database.Database) => void);

/** Миграции применяются последовательно по user_version. */
const MIGRATIONS: MigrationStep[] = [
  // v1 — исходная схема
  `
  CREATE TABLE IF NOT EXISTS groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    collapsed   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hosts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    address       TEXT    NOT NULL,
    port          INTEGER NOT NULL DEFAULT 22,
    username      TEXT    NOT NULL,
    auth_method   TEXT    NOT NULL,
    key_path      TEXT,
    group_id      INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    proxy_jump    TEXT,
    note          TEXT,
    guard_enabled INTEGER NOT NULL DEFAULT 1,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL
  );
  `,
  // v2 — proxy_jump становится рабочей ссылкой на другой хост (SSH-05, jump-хост)
  (db) => {
    db.exec(
      'ALTER TABLE hosts ADD COLUMN proxy_jump_host_id INTEGER REFERENCES hosts(id) ON DELETE SET NULL'
    );
    // Тихая техническая миграция данных: старое значение proxy_jump (текст)
    // превращается в ссылку, только если совпадает с именем существующего
    // хоста; иначе остаётся пустым — без уведомления пользователя.
    const rows = db
      .prepare("SELECT id, proxy_jump FROM hosts WHERE proxy_jump IS NOT NULL AND proxy_jump <> ''")
      .all() as Array<{ id: number; proxy_jump: string }>;
    if (rows.length === 0) return;
    const allHosts = db.prepare('SELECT id, name FROM hosts').all() as Array<{
      id: number;
      name: string;
    }>;
    // Сначала разрешаем все алиасы, затем отбрасываем связи, нарушающие
    // single-hop (ADR-0006): ребро X→Y выживает, только если у самого Y нет
    // исходящего ребра. Так после миграции цепочка A→B→C превращается в B→C
    // (A остаётся без jump-хоста), а взаимные ссылки A↔B исчезают целиком —
    // ни одна пара не может дать второй прыжок. Данные и так были нерабочими
    // (proxy_jump никогда не участвовал в подключении), поэтому потеря
    // неоднозначной связи безопаснее, чем молча собранная цепочка.
    const edges = new Map<number, number>();
    for (const row of rows) {
      const jumpId = resolveHostRefByName(allHosts, row.proxy_jump);
      if (jumpId !== null && jumpId !== row.id) edges.set(row.id, jumpId);
    }
    const setJumpId = db.prepare('UPDATE hosts SET proxy_jump_host_id = ? WHERE id = ?');
    for (const [hostId, jumpId] of edges) {
      if (!edges.has(jumpId)) setJumpId.run(jumpId, hostId);
    }
  },
  // v3 — history_enabled переезжает в hosts (HIST-07), dismissedAlerts —
  // в отдельную таблицу с каскадным удалением (.scratch/host-scoped-flags-to-db).
  // Оба поля были внешними ключами на hosts, положенными в config.json, у
  // которого нет ON DELETE CASCADE — отсюда и мигрируем: схема и разовый
  // перенос дожившего до этой миграции config.json в одном шаге.
  (db) => {
    db.exec(`
      ALTER TABLE hosts ADD COLUMN history_enabled INTEGER NOT NULL DEFAULT 1;

      CREATE TABLE host_dismissed_alerts (
        host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        issue   TEXT    NOT NULL,
        PRIMARY KEY (host_id, issue)
      );
    `);
    // history.perHostDisabled не читается: в релизной сборке он не может быть
    // непустым (нет писателя кроме GC) — переносить нечего.
    const dismissedAlerts = readDismissedAlertsFromConfigJson();
    if (Object.keys(dismissedAlerts).length === 0) return;
    const existingIds = new Set(
      (db.prepare('SELECT id FROM hosts').all() as Array<{ id: number }>).map((r) => r.id)
    );
    const insert = db.prepare(
      'INSERT OR IGNORE INTO host_dismissed_alerts (host_id, issue) VALUES (?, ?)'
    );
    for (const [hostIdStr, issues] of Object.entries(dismissedAlerts)) {
      const hostId = Number(hostIdStr);
      // Мьюты по id, которых нет в hosts, — накопленный мусор (config.json не
      // знает про ON DELETE CASCADE) — пропускаем, слепая вставка упала бы на FK.
      if (!existingIds.has(hostId)) continue;
      for (const issue of issues) insert.run(hostId, issue);
    }
  }
];

/**
 * Разовое чтение `dashboard.dismissedAlerts` из ещё не мигрировавшего
 * config.json (шаг v3). Отсутствующий, пустой или битый файл — штатный путь,
 * не исключение: существующие тесты миграций работают во временной папке без
 * config.json. Это одноразовое знание про формат config.json версии 1.0.1:
 * общий код настроек поле `dashboard` уже не читает (`loadConfig()` его
 * отбрасывает), поэтому оно живёт здесь, рядом с единственной миграцией,
 * которой нужно. Сырой файл должен быть прочитан до первой записи конфига —
 * порядок держит `startup/openLocalStores.ts`.
 */
function readDismissedAlertsFromConfigJson(): Record<number, string[]> {
  try {
    const raw = readFileSync(join(configDir(), 'config.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const dashboard = (parsed as Record<string, unknown>)['dashboard'];
    if (typeof dashboard !== 'object' || dashboard === null) return {};
    const dismissedAlerts = (dashboard as Record<string, unknown>)['dismissedAlerts'];
    if (typeof dismissedAlerts !== 'object' || dismissedAlerts === null || Array.isArray(dismissedAlerts)) {
      return {};
    }
    const out: Record<number, string[]> = {};
    for (const [hostIdStr, issues] of Object.entries(dismissedAlerts as Record<string, unknown>)) {
      const hostId = Number(hostIdStr);
      if (!Number.isInteger(hostId) || !Array.isArray(issues)) continue;
      const filtered = issues.filter(
        (i): i is string => typeof i === 'string' && (DASHBOARD_ALERT_ISSUES as readonly string[]).includes(i)
      );
      if (filtered.length > 0) out[hostId] = filtered;
    }
    return out;
  } catch {
    return {};
  }
}

export function hostsDbPath(): string {
  return join(configDir(), 'hosts.db');
}

export function openHostsDb(): Database.Database {
  if (db) return db;
  mkdirSync(configDir(), { recursive: true });
  const path = hostsDbPath();
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const current = db.pragma('user_version', { simple: true }) as number;
  if (current < MIGRATIONS.length) {
    // Резервная копия перед изменением схемы существующей БД (UPD-04)
    if (current > 0 && existsSync(path)) {
      copyFileSync(path, `${path}.backup-v${current}`);
    }
    const migrate = db.transaction(() => {
      for (let v = current; v < MIGRATIONS.length; v++) {
        const step = MIGRATIONS[v]!;
        if (typeof step === 'string') db!.exec(step);
        else step(db!);
      }
      db!.pragma(`user_version = ${MIGRATIONS.length}`);
    });
    migrate();
  }
  return db;
}

export function closeHostsDb(): void {
  db?.close();
  db = null;
}
