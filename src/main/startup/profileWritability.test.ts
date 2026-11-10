import Database from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Проверка записываемости Переносимого профиля (NFR-05, тикет 03): portable-
 * сборка стартует, только когда реально может писать в папку профиля,
 * конфигурацию, обе БД (проба записи с откатом, включая WAL), known_hosts,
 * sidecar-копии и каталог резервных копий. Отказ — понятная ошибка с именем
 * проблемного файла до миграций, без изменения пользовательских данных.
 * Тот же приём мока electron и реальной временной ФС, что в
 * startup/profileIdentity.test.ts.
 */

const ENV = 'PORTABLE_EXECUTABLE_DIR';

let dir = ''; // системный каталог (userData)
let exeDir = ''; // каталог исходного portable exe
let packaged = false;

vi.mock('electron', () => ({
  app: {
    getPath: () => dir,
    getVersion: () => '1.2.3-test',
    get isPackaged() {
      return packaged;
    },
  },
}));

const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')!;

function freshWritability(): Promise<typeof import('./profileWritability')> {
  vi.resetModules();
  return import('./profileWritability');
}

/** Portable-окружение: упакованная Windows-сборка, переменная указывает на exeDir. */
function portableEnv(): void {
  packaged = true;
  process.env[ENV] = exeDir;
  Object.defineProperty(process, 'platform', { value: 'win32' });
}

/** rmSync падает на read-only файлах (chmod 0444) на Windows — сначала снимаем атрибут. */
function rmTree(p: string): void {
  try {
    if (statSync(p).isDirectory()) {
      for (const e of readdirSync(p, { withFileTypes: true })) rmTree(join(p, e.name));
      rmSync(p, { recursive: true, force: true });
    } else {
      chmodSync(p, 0o666);
      rmSync(p, { force: true });
    }
  } catch {
    // уже удалено
  }
}

/** Существующий профиль: все известные артефакты, БД «старой» схемы (до миграций). */
function seedExistingProfile(): void {
  writeFileSync(join(exeDir, 'profile.id'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'utf8');
  writeFileSync(join(exeDir, 'config.json'), JSON.stringify({ language: 'ru' }), 'utf8');
  writeFileSync(join(exeDir, 'known_hosts'), 'example.test ssh-ed25519 AAAAC3NzaC11\n', 'utf8');

  const hosts = new Database(join(exeDir, 'hosts.db'));
  hosts.exec('CREATE TABLE hosts (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  hosts.exec("INSERT INTO hosts VALUES (1, 'web-01')");
  hosts.pragma('user_version = 2');
  hosts.close();

  const history = new Database(join(exeDir, 'history.db'));
  history.exec('CREATE TABLE history (id INTEGER PRIMARY KEY, command TEXT NOT NULL)');
  history.exec("INSERT INTO history VALUES (1, 'uptime')");
  history.pragma('user_version = 1');
  history.close();

  writeFileSync(join(exeDir, 'hosts.db.backup-v2'), 'копия перед миграцией');
  mkdirSync(join(exeDir, 'backups', 'pre-update-1'), { recursive: true });
  writeFileSync(join(exeDir, 'backups', 'pre-update-1', 'config.json'), '{}');
}

function readOnly(path: string): void {
  chmodSync(path, 0o444);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucidssh-wr-sys-'));
  exeDir = mkdtempSync(join(tmpdir(), 'lucidssh-wr-exe-'));
});

afterEach(() => {
  packaged = false;
  delete process.env[ENV];
  Object.defineProperty(process, 'platform', platformDesc);
  rmTree(dir);
  rmTree(exeDir);
});

describe('checkProfileWritability — не portable', () => {
  it('dev и установленная сборка: проверка не нужна, ничего не создаётся', async () => {
    process.env[ENV] = exeDir;
    const wr = await freshWritability();
    expect(wr.checkProfileWritability()).toEqual({ ok: true });
    expect(readdirSync(exeDir)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('checkProfileWritability — новый профиль', () => {
  it('пустая папка: ok, ничего не осталось (включая каталог backups)', async () => {
    portableEnv();
    const wr = await freshWritability();
    expect(wr.checkProfileWritability()).toEqual({ ok: true });
    expect(readdirSync(exeDir)).toEqual([]);
  });

  it('папка профиля занята обычным файлом: отказ с путём, ничего не создано', async () => {
    portableEnv();
    process.env[ENV] = join(exeDir, 'blocker');
    writeFileSync(process.env[ENV], 'x');
    const wr = await freshWritability();
    expect(wr.checkProfileWritability()).toEqual({ ok: false, file: process.env[ENV] });
    expect(readdirSync(exeDir)).toEqual(['blocker']);
  });
});

describe('checkProfileWritability — существующий профиль, всё записываемо', () => {
  it('ok; данные, схема и список файлов неизменны, probe-остатков нет', async () => {
    portableEnv();
    seedExistingProfile();
    const configBefore = readFileSync(join(exeDir, 'config.json'), 'utf8');
    const knownHostsBefore = readFileSync(join(exeDir, 'known_hosts'), 'utf8');
    const listingBefore = readdirSync(exeDir).sort();

    const wr = await freshWritability();
    expect(wr.checkProfileWritability()).toEqual({ ok: true });

    expect(readdirSync(exeDir).sort()).toEqual(listingBefore);
    expect(readFileSync(join(exeDir, 'config.json'), 'utf8')).toBe(configBefore);
    expect(readFileSync(join(exeDir, 'known_hosts'), 'utf8')).toBe(knownHostsBefore);

    // БД: данные и версия схемы на месте, таблица-проба не осталась; проба
    // перевела файл в WAL — так же делает и обычное открытие (openHostsDb)
    const hosts = new Database(join(exeDir, 'hosts.db'), { readonly: true });
    expect(hosts.prepare('SELECT name FROM hosts').all()).toEqual([{ name: 'web-01' }]);
    expect(hosts.pragma('user_version', { simple: true })).toBe(2);
    expect(hosts.pragma('journal_mode', { simple: true })).toBe('wal');
    hosts.close();
    const history = new Database(join(exeDir, 'history.db'), { readonly: true });
    expect(history.prepare('SELECT command FROM history').all()).toEqual([{ command: 'uptime' }]);
    expect(history.pragma('user_version', { simple: true })).toBe(1);
    history.close();
  });

  it('backups/ отсутствует: ok, недостающий каталог создан не был', async () => {
    portableEnv();
    writeFileSync(join(exeDir, 'profile.id'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'utf8');
    const wr = await freshWritability();
    expect(wr.checkProfileWritability()).toEqual({ ok: true });
    expect(existsSync(join(exeDir, 'backups'))).toBe(false);
  });
});

describe('checkProfileWritability — отказ с именем проблемного файла', () => {
  it.each([
    ['config.json', (f: string) => readOnly(join(f, 'config.json'))],
    ['known_hosts', (f: string) => readOnly(join(f, 'known_hosts'))],
    ['hosts.db', (f: string) => readOnly(join(f, 'hosts.db'))],
    ['history.db', (f: string) => readOnly(join(f, 'history.db'))],
    ['hosts.db.backup-v2', (f: string) => readOnly(join(f, 'hosts.db.backup-v2'))],
  ])('%s read-only → отказ с путём к файлу, данные не изменены', async (name, makeReadOnly) => {
    portableEnv();
    seedExistingProfile();
    makeReadOnly(exeDir);
    const listingBefore = readdirSync(exeDir, { recursive: true }).map(String).sort();

    const wr = await freshWritability();
    expect(wr.checkProfileWritability()).toEqual({ ok: false, file: join(exeDir, name) });
    // read-only снят — данные и список файлов должны быть прежними
    chmodSync(join(exeDir, name), 0o666);
    expect(readdirSync(exeDir, { recursive: true }).map(String).sort()).toEqual(listingBefore);
    const hosts = new Database(join(exeDir, 'hosts.db'), { readonly: true });
    expect(hosts.pragma('user_version', { simple: true })).toBe(2); // миграций не было
    hosts.close();
  });

  it('WAL недоступен (hosts.db-wal занят каталогом): отказ hosts.db, данные целы', async () => {
    portableEnv();
    seedExistingProfile();
    mkdirSync(join(exeDir, 'hosts.db-wal')); // SQLite не создаст WAL-файл
    const wr = await freshWritability();
    expect(wr.checkProfileWritability()).toEqual({ ok: false, file: join(exeDir, 'hosts.db') });
    rmSync(join(exeDir, 'hosts.db-wal'), { recursive: true, force: true });
    const hosts = new Database(join(exeDir, 'hosts.db'), { readonly: true });
    expect(hosts.prepare('SELECT name FROM hosts').all()).toEqual([{ name: 'web-01' }]);
    expect(hosts.pragma('user_version', { simple: true })).toBe(2);
    hosts.close();
  });

  it('backups занят обычным файлом: отказ backups, файл не тронут', async () => {
    portableEnv();
    writeFileSync(join(exeDir, 'profile.id'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'utf8');
    writeFileSync(join(exeDir, 'backups'), 'не каталог');
    const wr = await freshWritability();
    expect(wr.checkProfileWritability()).toEqual({ ok: false, file: join(exeDir, 'backups') });
    expect(readFileSync(join(exeDir, 'backups'), 'utf8')).toBe('не каталог');
  });

  it('hosts.db вместо файла — каталог: отказ hosts.db, миграции и копии не запускались', async () => {
    portableEnv();
    writeFileSync(join(exeDir, 'profile.id'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'utf8');
    mkdirSync(join(exeDir, 'hosts.db'));
    const wr = await freshWritability();
    expect(wr.checkProfileWritability()).toEqual({ ok: false, file: join(exeDir, 'hosts.db') });
    expect(readdirSync(exeDir).sort()).toEqual(['hosts.db', 'profile.id']);
  });

  it('отказ до миграций: sidecar-копия не создана, config.json и known_hosts не тронуты', async () => {
    portableEnv();
    seedExistingProfile();
    readOnly(join(exeDir, 'hosts.db')); // падаем на шаге БД
    const wr = await freshWritability();
    expect(wr.checkProfileWritability()).toEqual({ ok: false, file: join(exeDir, 'hosts.db') });
    chmodSync(join(exeDir, 'hosts.db'), 0o666);
    expect(existsSync(join(exeDir, 'hosts.db.backup-v3'))).toBe(false); // writeDbBackup не вызывался
    expect(readFileSync(join(exeDir, 'config.json'), 'utf8')).toBe(JSON.stringify({ language: 'ru' }));
    expect(readFileSync(join(exeDir, 'known_hosts'), 'utf8')).toBe('example.test ssh-ed25519 AAAAC3NzaC11\n');
  });
});
