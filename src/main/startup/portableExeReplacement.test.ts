import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ручное обновление portable заменой exe (NFR-05, тикет 07): папка профиля
 * прежней сборки (profile.id, config.json, hosts.db и history.db старой
 * схемы) открывается «новой сборкой» — profile.id и данные сохраняются,
 * миграции выполняются с резервной копией схемы, credentialId стабилен между
 * запусками (идентичность секретов не ломается). Реальная замена
 * опубликованной сборки — живая приёмка тикета 09. Тот же приём мока
 * electron и реальной временной ФС, что config/profileDir.test.ts;
 * better-sqlite3 — нативный, перед прогоном нужен `npm run rebuild:test`.
 */

const ENV = 'PORTABLE_EXECUTABLE_DIR';
const PROFILE_ID = 'a0b1c2d3-e4f5-4a06-b7c8-d9e0f1a2b3c4';
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let dir = ''; // системный каталог (userData)
let exeDir = ''; // каталог исходного portable exe

vi.mock('electron', () => ({
  app: {
    getPath: () => dir,
    getVersion: () => '1.2.3-test',
    get isPackaged() {
      return true;
    }
  }
}));

const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')!;

function portableEnv(): void {
  process.env[ENV] = exeDir;
  Object.defineProperty(process, 'platform', { value: 'win32' }); // portable-режим существует только на Windows, а CI гоняет тесты и на Linux
}

/** Профиль прежней сборки: валидный profile.id и обе БД старой схемы. */
async function seedOldProfile(): Promise<void> {
  writeFileSync(join(exeDir, 'profile.id'), PROFILE_ID, 'utf8');
  writeFileSync(join(exeDir, 'config.json'), '{}', 'utf8');

  const { default: Database } = await import('better-sqlite3');
  const hosts = new Database(join(exeDir, 'hosts.db'));
  hosts.exec(`
    CREATE TABLE groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0, collapsed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL, auth_method TEXT NOT NULL,
      key_path TEXT, group_id INTEGER, proxy_jump TEXT,
      proxy_jump_host_id INTEGER REFERENCES hosts(id) ON DELETE SET NULL, note TEXT,
      guard_enabled INTEGER NOT NULL DEFAULT 1, history_enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE host_dismissed_alerts (
      host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
      issue TEXT NOT NULL, PRIMARY KEY (host_id, issue)
    );
    INSERT INTO hosts (name, address, port, username, auth_method, created_at, updated_at)
      VALUES ('web-01', '203.0.113.10', 22, 'root', 'password', '2026-01-01', '2026-01-01');
    PRAGMA user_version = 3;
  `);
  hosts.close();

  const history = new Database(join(exeDir, 'history.db'));
  history.exec(`
    CREATE TABLE history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, command TEXT NOT NULL, host_id INTEGER,
      host_name TEXT NOT NULL, username TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
      exit_code INTEGER, guard_status TEXT, has_secret INTEGER NOT NULL DEFAULT 0,
      is_favorite INTEGER NOT NULL DEFAULT 0, note TEXT,
      output TEXT, output_truncated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE snippets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, command TEXT NOT NULL,
      description TEXT, host_id INTEGER, danger INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO history (command, host_id, host_name, username, started_at, has_secret, output, output_truncated)
      VALUES ('cat /etc/shadow', 1, 'web-01', 'root', '2026-01-02', 1, 'legacy-output', 1),
             ('ls -la', 1, 'web-01', 'root', '2026-01-03', 0, NULL, 0);
    PRAGMA user_version = 4;
  `);
  history.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucidssh-replace-sys-'));
  exeDir = mkdtempSync(join(tmpdir(), 'lucidssh-replace-exe-'));
  portableEnv();
});

afterEach(async () => {
  delete process.env[ENV];
  Object.defineProperty(process, 'platform', platformDesc);
  (await import('../hosts/db')).closeHostsDb();
  (await import('../history/db')).closeHistoryDb();
  rmSync(dir, { recursive: true, force: true });
  rmSync(exeDir, { recursive: true, force: true });
});

describe('замена portable exe со старой схемой БД (тикет 07)', () => {
  it('profile.id, хосты, история и идентичности сохраняются; схема мигрирует с копией', async () => {
    await seedOldProfile();

    // «Новая сборка» запускается на папке прежней: идентичность профиля прежняя.
    const identity = await import('./profileIdentity');
    expect(identity.prepareProfileIdentity()).toEqual({ ok: true, profileId: PROFILE_ID });

    const hostsDb = (await import('../hosts/db')).openHostsDb();
    const host = hostsDb
      .prepare('SELECT name, address, username, credential_id FROM hosts')
      .get() as { name: string; address: string; username: string; credential_id: string };
    expect(host).toMatchObject({ name: 'web-01', address: '203.0.113.10', username: 'root' });
    // v4 присвоила постоянный credentialId — часть адреса записи Хранилища секретов
    expect(host.credential_id).toMatch(UUID_V4_RE);
    // Резервная копия схемы перед необратимой миграцией (UPD-04)
    expect(existsSync(join(exeDir, 'hosts.db.backup-v3'))).toBe(true);

    const historyDb = (await import('../history/db')).openHistoryDb();
    const rows = historyDb
      .prepare('SELECT command, has_secret, output FROM history ORDER BY started_at')
      .all() as Array<{ command: string; has_secret: number; output: string | null }>;
    expect(rows.map((r) => r.command)).toEqual(['cat /etc/shadow', 'ls -la']);
    expect(rows[0]!.has_secret).toBe(1); // факт наличия секрета переживает миграцию
    expect(rows.every((r) => r.output === null)).toBe(true); // v5 стирает вывод (HIST-09)
    // Копия history.db удалена: v5 стёрла вывод, копии его сохраняли бы (HIST-09)
    expect(existsSync(join(exeDir, 'history.db.backup-v4'))).toBe(false);

    // Файлы профиля прежней сборки на месте
    expect(readFileSync(join(exeDir, 'profile.id'), 'utf8')).toBe(PROFILE_ID);
    expect(existsSync(join(exeDir, 'config.json'))).toBe(true);

    // Повторный запуск («еще одна» замена exe): данные и идентичности стабильны
    (await import('../hosts/db')).closeHostsDb();
    (await import('../history/db')).closeHistoryDb();
    vi.resetModules();
    const identity2 = await import('./profileIdentity');
    expect(identity2.prepareProfileIdentity()).toEqual({ ok: true, profileId: PROFILE_ID });
    const hostsDb2 = (await import('../hosts/db')).openHostsDb();
    expect(hostsDb2.prepare('SELECT credential_id FROM hosts').get()).toEqual({
      credential_id: host.credential_id
    });
    const historyDb2 = (await import('../history/db')).openHistoryDb();
    expect(historyDb2.prepare('SELECT COUNT(*) AS n FROM history').get()).toEqual({ n: 2 });
  });
});
