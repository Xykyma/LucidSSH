import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * HIST-09 и уточнения HIST-08/UPD-04 (security-скан, тикет 10): удаление из
 * истории стирает копии history.db и следы в WAL, вывод стирается при
 * выключении настройки и миграцией v5, копии ротируются до одной на вид.
 * «Следов нет» проверяем по файлам каталога данных и по байтам history.db/-wal.
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
  dir = mkdtempSync(join(tmpdir(), 'lucidssh-retention-test-'));
});

afterEach(async () => {
  const { closeHistoryDb } = await import('./db');
  closeHistoryDb();
  rmSync(dir, { recursive: true, force: true });
});

const MARKER = 'marker-xyzzy-12345';
const rec = (hostId: number) => ({ command: `echo ${MARKER}`, hostId, hostName: `h${hostId}`, username: 'u' });

function bytesOfLiveDb(): string {
  return ['history.db', 'history.db-wal']
    .map((n) => (existsSync(join(dir, n)) ? readFileSync(join(dir, n)).toString('latin1') : ''))
    .join('');
}

/** Копии всех видов: миграционная и pre-update (с hosts.db/config.json рядом). */
function plantBackups(): { purged: string[]; kept: string[] } {
  const pre = join(dir, 'backups', 'pre-update-1');
  mkdirSync(pre, { recursive: true });
  const purged = [join(dir, 'history.db.backup-v3'), join(pre, 'history.db')];
  const kept = [join(dir, 'hosts.db.backup-v2'), join(pre, 'hosts.db'), join(pre, 'config.json')];
  for (const f of [...purged, ...kept]) writeFileSync(f, MARKER);
  return { purged, kept };
}

describe('удаление из истории по действию пользователя (HIST-08)', () => {
  it.each([
    ['clearHistory', (r: typeof import('./repository')) => r.clearHistory()],
    ['clearHistoryForHost', (r: typeof import('./repository')) => r.clearHistoryForHost(1)],
    ['deleteHistoryEntry', (r: typeof import('./repository')) => r.deleteHistoryEntry(1)],
    ['eraseStoredOutput', (r: typeof import('./repository')) => r.eraseStoredOutput()]
  ])('%s удаляет копии history.db, hosts.db и config.json остаются', async (_name, act) => {
    const repo = await freshRepo();
    repo.recordHistory({ ...rec(1), output: 'listing' });
    const { purged, kept } = plantBackups();

    act(repo);

    for (const f of purged) expect(existsSync(f), f).toBe(false);
    for (const f of kept) expect(existsSync(f), f).toBe(true);
  });

  it('после очистки хоста его строки не находятся поиском по байтам history.db и -wal', async () => {
    const repo = await freshRepo();
    for (let i = 0; i < 20; i++) repo.recordHistory(rec(1));
    expect(bytesOfLiveDb()).toContain(MARKER);

    repo.clearHistoryForHost(1);

    expect(bytesOfLiveDb()).not.toContain(MARKER);
  });

  it('FIFO-вытеснение (HIST-06) копии не трогает', async () => {
    const repo = await freshRepo();
    const { openHistoryDb } = await import('./db');
    const db = openHistoryDb();
    const ins = db.prepare(
      `INSERT INTO history (command, host_id, host_name, username, started_at) VALUES ('c', 1, 'h', 'u', ?)`
    );
    db.transaction(() => {
      for (let i = 0; i < 10_000; i++) ins.run(new Date(2026, 0, 1, 0, 0, i).toISOString());
    })();
    const { purged } = plantBackups();

    repo.recordHistory(rec(1)); // 10 001-я запись → вытеснение старейшей

    expect(repo.totalHistoryCount()).toBe(10_000);
    for (const f of purged) expect(existsSync(f), f).toBe(true);
  });

  it('обычная запись (выключатели истории лишь останавливают её) копии не трогает', async () => {
    const repo = await freshRepo();
    const { purged } = plantBackups();
    repo.recordHistory(rec(1));
    for (const f of purged) expect(existsSync(f), f).toBe(true);
  });
});

describe('eraseStoredOutput (HIST-09: выключение «Сохранять вывод команд»)', () => {
  it('стирает вывод у всех записей, has_secret остаётся, байтов вывода в файлах нет', async () => {
    const repo = await freshRepo();
    repo.recordHistory({ ...rec(1), output: 'marker-output-777' });
    repo.recordHistory({ ...rec(2), output: '-----BEGIN RSA PRIVATE KEY-----' }); // секрет: вывод не сохранён
    expect(bytesOfLiveDb()).toContain('marker-output-777');

    repo.eraseStoredOutput();

    const rows = repo.listHistory();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.output === undefined && r.outputTruncated === false)).toBe(true);
    expect(rows.filter((r) => r.hasSecret)).toHaveLength(1);
    expect(bytesOfLiveDb()).not.toContain('marker-output-777');
  });
});

describe('history.db — миграция v5 стирает вывод прежних версий (HIST-09)', () => {
  /** БД версии 4, как её оставили прежние релизы: с выводом в записях. */
  async function seedV4(): Promise<void> {
    const { default: Database } = await import('better-sqlite3');
    const old = new Database(join(dir, 'history.db'));
    old.exec(`
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
      INSERT INTO history (command, host_name, username, started_at, has_secret, output, output_truncated)
        VALUES ('cat /etc/shadow', 'h', 'u', '2026-01-01', 1, 'legacy-output-marker', 1),
               ('ls', 'h', 'u', '2026-01-02', 0, 'legacy-output-marker-2', 0);
      PRAGMA user_version = 4;
    `);
    old.close();
  }

  it('стирает вывод, записи и has_secret целы; копии history.db, включая v4, удалены', async () => {
    await seedV4();
    const pre = join(dir, 'backups', 'pre-update-9');
    mkdirSync(pre, { recursive: true });
    writeFileSync(join(pre, 'history.db'), 'legacy-output-marker');
    writeFileSync(join(pre, 'hosts.db'), 'x');
    writeFileSync(join(dir, 'history.db.backup-v2'), 'legacy-output-marker');

    const repo = await freshRepo();
    const rows = repo.listHistory();

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.output === undefined && r.outputTruncated === false)).toBe(true);
    expect(rows.find((r) => r.command === 'cat /etc/shadow')!.hasSecret).toBe(true);
    expect(existsSync(join(dir, 'history.db.backup-v4'))).toBe(false);
    expect(existsSync(join(dir, 'history.db.backup-v2'))).toBe(false);
    expect(existsSync(join(pre, 'history.db'))).toBe(false);
    expect(existsSync(join(pre, 'hosts.db'))).toBe(true);
    expect(bytesOfLiveDb()).not.toContain('legacy-output-marker');
  });

  it('вывод строк, удалённых до обновления без secure_delete (1.0.2), не остаётся в свободных страницах', async () => {
    await seedV4();
    const { default: Database } = await import('better-sqlite3');
    const old = new Database(join(dir, 'history.db'));
    old.pragma('journal_mode = WAL');
    const ins = old.prepare(
      `INSERT INTO history (command, host_name, username, started_at, output) VALUES ('x', 'h', 'u', '2026-01-03', ?)`
    );
    for (let i = 0; i < 20; i++) ins.run(`deleted-long-ago-marker ${'y'.repeat(500)}`);
    old.exec(`DELETE FROM history WHERE command = 'x'`); // secure_delete выключен — как в 1.0.2
    old.close();
    expect(bytesOfLiveDb()).toContain('deleted-long-ago-marker');

    (await freshRepo()).listHistory();

    expect(bytesOfLiveDb()).not.toContain('deleted-long-ago-marker');
  });

  it('сбой VACUUM не роняет запуск: v5 уже закоммичена, вывод стёрт', async () => {
    await seedV4();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { default: Database } = await import('better-sqlite3');
    const orig = Database.prototype.exec;
    vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: unknown, sql: string) {
      if (sql === 'VACUUM') throw new Error('disk full');
      return orig.call(this, sql);
    });

    const rows = (await freshRepo()).listHistory();

    expect(rows.every((r) => r.output === undefined)).toBe(true);
    expect(err).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('на свежем профиле копий не создаёт и чужих не удаляет', async () => {
    const stray = join(dir, 'history.db.backup-v1');
    writeFileSync(stray, 'x');

    const repo = await freshRepo();
    repo.listHistory();

    expect(existsSync(stray)).toBe(true);
  });

  it('на БД, уже дошедшей до v5, снова не стирает вывод и не трогает копии', async () => {
    const repo = await freshRepo();
    repo.recordHistory({ ...rec(1), output: 'fresh-output' });
    const { closeHistoryDb } = await import('./db');
    closeHistoryDb();
    const { purged } = plantBackups();

    const again = await freshRepo();

    expect(again.listHistory()[0]!.output).toBe('fresh-output');
    for (const f of purged) expect(existsSync(f), f).toBe(true);
  });
});

describe('ротация резервных копий (UPD-04): сначала запись, потом удаление прежних', () => {
  async function freshBackups(): Promise<typeof import('./backups')> {
    vi.resetModules();
    return import('./backups');
  }

  it('writeDbBackup пишет новую копию и удаляет прежние .backup-v* этой БД, чужие не трогает', async () => {
    writeFileSync(join(dir, 'history.db'), 'live');
    writeFileSync(join(dir, 'history.db.backup-v0'), 'old');
    writeFileSync(join(dir, 'history.db.backup-v3'), 'old');
    writeFileSync(join(dir, 'hosts.db.backup-v1'), 'other db');

    (await freshBackups()).writeDbBackup(join(dir, 'history.db'), 4);

    expect(readFileSync(join(dir, 'history.db.backup-v4'), 'utf8')).toBe('live');
    expect(existsSync(join(dir, 'history.db.backup-v0'))).toBe(false);
    expect(existsSync(join(dir, 'history.db.backup-v3'))).toBe(false);
    expect(existsSync(join(dir, 'hosts.db.backup-v1'))).toBe(true);
  });

  it('writeDbBackup: копирование упало — прежняя копия остаётся', async () => {
    writeFileSync(join(dir, 'history.db.backup-v3'), 'old');

    // исходного history.db нет → copyFileSync бросает
    const { writeDbBackup } = await freshBackups();
    expect(() => writeDbBackup(join(dir, 'history.db'), 4)).toThrow();

    expect(readFileSync(join(dir, 'history.db.backup-v3'), 'utf8')).toBe('old');
  });

  it('миграция hosts.db: прежняя .backup-v* заменяется новой — копия одна', async () => {
    const { default: Database } = await import('better-sqlite3');
    const old = new Database(join(dir, 'hosts.db'));
    old.exec('CREATE TABLE hosts (id INTEGER PRIMARY KEY, name TEXT, proxy_jump TEXT); PRAGMA user_version = 1;');
    old.close();
    writeFileSync(join(dir, 'hosts.db.backup-v0'), 'stale');

    vi.resetModules();
    const hostsDb = await import('../hosts/db');
    hostsDb.openHostsDb();

    expect(existsSync(join(dir, 'hosts.db.backup-v0'))).toBe(false);
    expect(existsSync(join(dir, 'hosts.db.backup-v1'))).toBe(true);
    hostsDb.closeHostsDb();
  });

  it('writePreUpdateBackup копирует перечисленные файлы, пропускает отсутствующие и убирает прежние pre-update-*', async () => {
    for (const name of ['pre-update-1', 'pre-update-2', 'manual-keep']) {
      mkdirSync(join(dir, 'backups', name), { recursive: true });
      writeFileSync(join(dir, 'backups', name, 'history.db'), 'x');
    }
    writeFileSync(join(dir, 'hosts.db'), 'hosts');
    writeFileSync(join(dir, 'history.db'), 'history');

    (await freshBackups()).writePreUpdateBackup(['hosts.db', 'history.db', 'config.json']);

    const fresh = readdirSync(join(dir, 'backups')).filter((n) => n.startsWith('pre-update-'));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).not.toMatch(/^pre-update-[12]$/);
    expect(readFileSync(join(dir, 'backups', fresh[0]!, 'hosts.db'), 'utf8')).toBe('hosts');
    expect(readFileSync(join(dir, 'backups', fresh[0]!, 'history.db'), 'utf8')).toBe('history');
    expect(existsSync(join(dir, 'backups', fresh[0]!, 'config.json'))).toBe(false);
    expect(existsSync(join(dir, 'backups', 'manual-keep'))).toBe(true);
  });

  it('writePreUpdateBackup: копирование упало — прежняя pre-update-* цела, недописанной папки нет', async () => {
    mkdirSync(join(dir, 'backups', 'pre-update-1'), { recursive: true });
    writeFileSync(join(dir, 'backups', 'pre-update-1', 'history.db'), 'old');
    writeFileSync(join(dir, 'config.json'), '{}');
    mkdirSync(join(dir, 'hosts.db')); // каталог вместо файла: copyFileSync бросает EISDIR

    const { writePreUpdateBackup } = await freshBackups();
    expect(() => writePreUpdateBackup(['config.json', 'hosts.db'])).toThrow();

    expect(readdirSync(join(dir, 'backups'))).toEqual(['pre-update-1']);
    expect(readFileSync(join(dir, 'backups', 'pre-update-1', 'history.db'), 'utf8')).toBe('old');
  });

  it('purgeHistoryBackups без каталога backups и без копий — не падает', async () => {
    const { purgeHistoryBackups } = await freshBackups();
    expect(() => purgeHistoryBackups(join(dir, 'history.db'))).not.toThrow();
  });
});
