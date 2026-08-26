import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * hosts.db — миграция v2 (proxy_jump_host_id) и repository-слой jump-хоста
 * (тикет 01, .scratch/jump-host-support). Тот же приём мока electron, что и
 * config/store.test.ts / history/snippets.test.ts.
 */
let dir = '';
vi.mock('electron', () => ({
  app: {
    getPath: () => dir,
    getVersion: () => '1.2.3-test'
  }
}));

async function freshRepo(): Promise<typeof import('./repository')> {
  vi.resetModules();
  return import('./repository');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucidssh-hosts-test-'));
});

afterEach(async () => {
  const { closeHostsDb } = await import('./db');
  closeHostsDb();
  rmSync(dir, { recursive: true, force: true });
});

const base = {
  address: '203.0.113.10',
  port: 22,
  username: 'root',
  authMethod: 'password' as const,
  guardEnabled: true,
  historyEnabled: true
};

describe('createHost / getHost / updateHost — proxyJumpHostId', () => {
  it('сохраняет и читает proxyJumpHostId', async () => {
    const repo = await freshRepo();
    const bastionId = repo.createHost({ ...base, name: 'bastion' });
    const targetId = repo.createHost({ ...base, name: 'prod-db', proxyJumpHostId: bastionId });

    const target = repo.getHost(targetId);
    expect(target?.proxyJumpHostId).toBe(bastionId);
  });

  it('без jump-хоста — proxyJumpHostId undefined, не null/0', async () => {
    const repo = await freshRepo();
    const id = repo.createHost({ ...base, name: 'solo' });
    expect(repo.getHost(id)?.proxyJumpHostId).toBeUndefined();
  });

  it('updateHost меняет и сбрасывает proxyJumpHostId', async () => {
    const repo = await freshRepo();
    const bastionId = repo.createHost({ ...base, name: 'bastion' });
    const targetId = repo.createHost({ ...base, name: 'prod-db' });

    repo.updateHost(targetId, { ...base, name: 'prod-db', proxyJumpHostId: bastionId });
    expect(repo.getHost(targetId)?.proxyJumpHostId).toBe(bastionId);

    repo.updateHost(targetId, { ...base, name: 'prod-db' });
    expect(repo.getHost(targetId)?.proxyJumpHostId).toBeUndefined();
  });

  it('удаление bastion-хоста обнуляет proxyJumpHostId у зависимых (ON DELETE SET NULL)', async () => {
    const repo = await freshRepo();
    const bastionId = repo.createHost({ ...base, name: 'bastion' });
    const targetId = repo.createHost({ ...base, name: 'prod-db', proxyJumpHostId: bastionId });

    repo.deleteHost(bastionId);

    expect(repo.getHost(targetId)?.proxyJumpHostId).toBeUndefined();
  });
});

describe('listHostsReferencingProxyJump', () => {
  it('находит все хосты, использующие данный хост как jump-хост', async () => {
    const repo = await freshRepo();
    const bastionId = repo.createHost({ ...base, name: 'bastion' });
    const otherId = repo.createHost({ ...base, name: 'other' });
    repo.createHost({ ...base, name: 'prod-db', proxyJumpHostId: bastionId });
    repo.createHost({ ...base, name: 'staging-db', proxyJumpHostId: bastionId });
    repo.createHost({ ...base, name: 'unrelated' });

    const dependents = repo.listHostsReferencingProxyJump(bastionId).map((h) => h.name).sort();
    expect(dependents).toEqual(['prod-db', 'staging-db']);
    expect(repo.listHostsReferencingProxyJump(otherId)).toEqual([]);
  });
});

describe('checkJumpHost — инвариант single-hop (ADR-0006)', () => {
  it('обычный хост без своего jump-хоста подходит', async () => {
    const repo = await freshRepo();
    const bastionId = repo.createHost({ ...base, name: 'bastion' });
    const targetId = repo.createHost({ ...base, name: 'prod-db' });

    expect(repo.checkJumpHost(bastionId, targetId)).toBeNull();
    // Создание нового хоста — зависимых ещё нет, hostId не передаётся.
    expect(repo.checkJumpHost(bastionId)).toBeNull();
  });

  it('сам себе jump-хост — self', async () => {
    const repo = await freshRepo();
    const id = repo.createHost({ ...base, name: 'solo' });
    expect(repo.checkJumpHost(id, id)).toBe('self');
  });

  it('несуществующий хост — not-found', async () => {
    const repo = await freshRepo();
    expect(repo.checkJumpHost(4242)).toBe('not-found');
  });

  it('у выбранного bastion есть свой jump-хост — chain', async () => {
    const repo = await freshRepo();
    const rootId = repo.createHost({ ...base, name: 'root-bastion' });
    const midId = repo.createHost({ ...base, name: 'mid', proxyJumpHostId: rootId });
    const targetId = repo.createHost({ ...base, name: 'prod-db' });

    expect(repo.checkJumpHost(midId, targetId)).toBe('chain');
  });

  it('редактируемый хост сам служит чьим-то jump-хостом — chain (обратная сторона)', async () => {
    const repo = await freshRepo();
    const midId = repo.createHost({ ...base, name: 'mid' });
    repo.createHost({ ...base, name: 'prod-db', proxyJumpHostId: midId });
    const otherId = repo.createHost({ ...base, name: 'other' });

    // Именно этот случай фильтр кандидатов в форме не ловил: mid — валидный
    // кандидат сам по себе, но назначать ему jump уже нельзя.
    expect(repo.checkJumpHost(otherId, midId)).toBe('chain');
  });
});

describe('миграция v2 — бэкфилл proxy_jump_host_id из старого текстового proxy_jump', () => {
  it('связывает proxy_jump с id хоста при точном совпадении имени', async () => {
    // Готовим "старую" БД по схеме v1 напрямую, до подключения db.ts/openHostsDb.
    const path = join(dir, 'hosts.db');
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0, collapsed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE hosts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL, auth_method TEXT NOT NULL,
        key_path TEXT, group_id INTEGER, proxy_jump TEXT, note TEXT,
        guard_enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    raw
      .prepare(
        `INSERT INTO hosts (name, address, port, username, auth_method, proxy_jump, guard_enabled, created_at, updated_at)
         VALUES (?, ?, 22, 'root', 'password', ?, 1, ?, ?)`
      )
      .run('bastion', '203.0.113.1', null, now, now);
    raw
      .prepare(
        `INSERT INTO hosts (name, address, port, username, auth_method, proxy_jump, guard_enabled, created_at, updated_at)
         VALUES (?, ?, 22, 'root', 'password', ?, 1, ?, ?)`
      )
      .run('prod-db', '203.0.113.2', 'bastion', now, now);
    raw
      .prepare(
        `INSERT INTO hosts (name, address, port, username, auth_method, proxy_jump, guard_enabled, created_at, updated_at)
         VALUES (?, ?, 22, 'root', 'password', ?, 1, ?, ?)`
      )
      .run('orphan-db', '203.0.113.3', 'unknown-host', now, now);
    raw.pragma('user_version = 1');
    raw.close();

    // Теперь открываем через настоящий модуль — миграция v2 должна отработать.
    const repo = await freshRepo();
    const bastion = repo.listHosts().find((h) => h.name === 'bastion')!;
    const prodDb = repo.listHosts().find((h) => h.name === 'prod-db')!;
    const orphanDb = repo.listHosts().find((h) => h.name === 'orphan-db')!;

    expect(prodDb.proxyJumpHostId).toBe(bastion.id);
    expect(orphanDb.proxyJumpHostId).toBeUndefined();
  });

  it('цепочка A→B→C из старых данных не переезжает целиком (ADR-0006)', async () => {
    const path = join(dir, 'hosts.db');
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0, collapsed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE hosts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL, auth_method TEXT NOT NULL,
        key_path TEXT, group_id INTEGER, proxy_jump TEXT, note TEXT,
        guard_enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    const insert = raw.prepare(
      `INSERT INTO hosts (name, address, port, username, auth_method, proxy_jump, guard_enabled, created_at, updated_at)
       VALUES (?, ?, 22, 'root', 'password', ?, 1, ?, ?)`
    );
    insert.run('a', '203.0.113.1', 'b', now, now);
    insert.run('b', '203.0.113.2', 'c', now, now);
    insert.run('c', '203.0.113.3', null, now, now);
    raw.pragma('user_version = 1');
    raw.close();

    const repo = await freshRepo();
    const a = repo.listHosts().find((h) => h.name === 'a')!;
    const b = repo.listHosts().find((h) => h.name === 'b')!;
    const c = repo.listHosts().find((h) => h.name === 'c')!;

    // Выживает только ребро, чья цель никуда не ходит: b→c.
    expect(b.proxyJumpHostId).toBe(c.id);
    expect(a.proxyJumpHostId).toBeUndefined();
  });

  it('взаимные ссылки A↔B отбрасываются целиком', async () => {
    const path = join(dir, 'hosts.db');
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0, collapsed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE hosts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL, auth_method TEXT NOT NULL,
        key_path TEXT, group_id INTEGER, proxy_jump TEXT, note TEXT,
        guard_enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    const insert = raw.prepare(
      `INSERT INTO hosts (name, address, port, username, auth_method, proxy_jump, guard_enabled, created_at, updated_at)
       VALUES (?, ?, 22, 'root', 'password', ?, 1, ?, ?)`
    );
    insert.run('a', '203.0.113.1', 'b', now, now);
    insert.run('b', '203.0.113.2', 'a', now, now);
    raw.pragma('user_version = 1');
    raw.close();

    const repo = await freshRepo();
    for (const h of repo.listHosts()) expect(h.proxyJumpHostId).toBeUndefined();
  });

  it('пустой/отсутствующий proxy_jump не создаёт ссылку и не падает', async () => {
    // Свежая БД, сразу по актуальной схеме (v1+v2) — без ручной подготовки v1-файла.
    const repo = await freshRepo();
    const id = repo.createHost({ ...base, name: 'solo' });
    expect(repo.getHost(id)?.proxyJumpHostId).toBeUndefined();
  });
});

describe('миграция v3 — history_enabled + перенос dashboard.dismissedAlerts из config.json', () => {
  /** Готовит "старую" БД по схеме v1+v2 напрямую, до подключения db.ts. */
  function seedV2Db(): { path: string; existingId: number } {
    const path = join(dir, 'hosts.db');
    const raw = new Database(path);
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
    return { path, existingId: Number(res.lastInsertRowid) };
  }

  it('history_enabled появляется со значением 1 по умолчанию у существующих строк', async () => {
    seedV2Db();
    const repo = await freshRepo();
    expect(repo.listHosts()[0]?.historyEnabled).toBe(true);
  });

  it('переносит мьюты существующего хоста, отбрасывает мьюты удалённого', async () => {
    const { existingId } = seedV2Db();
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        dashboard: {
          dismissedAlerts: {
            [existingId]: ['cpu', 'rebootRequired'],
            9999: ['ram'] // хост давно удалён — накопленный мусор, не переносится
          }
        }
      }),
      'utf8'
    );

    await freshRepo();
    const { listDismissedAlerts } = await import('./dashboardMutes');
    expect(listDismissedAlerts(existingId).sort()).toEqual(['cpu', 'rebootRequired']);
    expect(listDismissedAlerts(9999)).toEqual([]);
  });

  it('отсутствующий config.json — открытие БД не падает, мьютов нет', async () => {
    seedV2Db();
    const repo = await freshRepo();
    expect(repo.listHosts()).toHaveLength(1);
    const { listDismissedAlerts } = await import('./dashboardMutes');
    expect(listDismissedAlerts(1)).toEqual([]);
  });

  it('битый config.json — открытие БД не падает', async () => {
    seedV2Db();
    writeFileSync(join(dir, 'config.json'), '{ not valid json', 'utf8');
    const repo = await freshRepo();
    expect(repo.listHosts()).toHaveLength(1);
  });

  it('идемпотентность: повторное открытие БД не дублирует мьюты (PRIMARY KEY)', async () => {
    const { existingId } = seedV2Db();
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ dashboard: { dismissedAlerts: { [existingId]: ['cpu'] } } }),
      'utf8'
    );
    await freshRepo();
    const { closeHostsDb } = await import('./db');
    closeHostsDb();
    // Второе "открытие" — user_version уже 3, миграция v3 не выполняется повторно.
    const repo2 = await freshRepo();
    repo2.listHosts();
    const { listDismissedAlerts } = await import('./dashboardMutes');
    expect(listDismissedAlerts(existingId)).toEqual(['cpu']);
  });
});

describe('каскад удаления хоста (hosts.db, foreign_keys=ON) — host_dismissed_alerts', () => {
  it('удаление хоста уносит его мьюты без ручной сборки мусора', async () => {
    const repo = await freshRepo();
    const { addDismissedAlert, listDismissedAlerts } = await import('./dashboardMutes');
    const id = repo.createHost({ ...base, name: 'web-01' });
    addDismissedAlert(id, 'cpu');
    addDismissedAlert(id, 'disk');
    expect(listDismissedAlerts(id).sort()).toEqual(['cpu', 'disk']);

    repo.deleteHost(id);

    expect(listDismissedAlerts(id)).toEqual([]);
  });
});
