import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Порядок открытия локальных хранилищ при старте main (UPD-04, ADR-0015):
 * мьюты дашборда из config.json версии 1.0.1 должны пережить первую запись
 * конфига, которую приложение делает само, без участия пользователя. Тот же
 * приём мока electron, что и hosts/repository.test.ts.
 */
let dir = '';
vi.mock('electron', () => ({
  app: {
    getPath: () => dir,
    getVersion: () => '1.2.3-test'
  }
}));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucidssh-startup-test-'));
  vi.resetModules();
});

afterEach(async () => {
  const { closeHostsDb } = await import('../hosts/db');
  closeHostsDb();
  rmSync(dir, { recursive: true, force: true });
});

/** hosts.db в том виде, в каком его оставила 1.0.1: схема v2, один хост. */
function seedV2HostsDb(): number {
  const raw = new Database(join(dir, 'hosts.db'));
  raw.exec(`
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
      guard_enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  const res = raw
    .prepare(
      `INSERT INTO hosts (name, address, port, username, auth_method, guard_enabled, created_at, updated_at)
       VALUES ('web-01', '203.0.113.10', 22, 'root', 'password', 1, ?, ?)`
    )
    .run(now, now);
  raw.pragma('user_version = 2');
  raw.close();
  return Number(res.lastInsertRowid);
}

describe('openLocalStores — hosts.db открывается до config.json', () => {
  it('мьюты из config.json 1.0.1 переживают первую запись конфига после старта', async () => {
    const hostId = seedV2HostsDb();
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        version: '1.0.1',
        window: { width: 1280, height: 800, maximized: true },
        dashboard: { dismissedAlerts: { [hostId]: ['cpu'] } }
      }),
      'utf8'
    );

    const { openLocalStores } = await import('./openLocalStores');
    openLocalStores();
    // Так конфиг пишет persistWindowState через 400 мс после maximize() —
    // до того, как renderer успеет запросить список хостов.
    const { updateConfig } = await import('../config/store');
    updateConfig(() => {});
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).not.toHaveProperty('dashboard');

    const { closeHostsDb } = await import('../hosts/db');
    closeHostsDb();
    vi.resetModules();
    const { listDismissedAlerts } = await import('../hosts/dashboardMutes');
    expect(listDismissedAlerts(hostId)).toEqual(['cpu']);
  });

  it('hosts.db не открывается — запуск не падает, конфиг всё равно загружен', async () => {
    mkdirSync(join(dir, 'hosts.db')); // каталог на месте файла: SQLite не откроет
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en' }), 'utf8');

    const { openLocalStores } = await import('./openLocalStores');
    expect(() => openLocalStores()).not.toThrow();
    const { loadConfig } = await import('../config/store');
    expect(loadConfig().language).toBe('en');
  });
});
