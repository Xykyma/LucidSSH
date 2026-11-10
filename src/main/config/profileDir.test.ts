import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Выбор каталога профиля (NFR-05, тикет 01): упакованная Windows portable-сборка
 * держит все данные рядом с исходным exe (PORTABLE_EXECUTABLE_DIR от
 * electron-builder), установленная сборка, dev и другие платформы — в
 * системном каталоге. Тот же приём мока electron и реальной временной ФС, что
 * в config/store.test.ts; process.platform стаббится через
 * Object.defineProperty (дескриптор configurable), после теста возвращается.
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
    }
  }
}));

const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')!;

function freshStore(): Promise<typeof import('./store')> {
  vi.resetModules();
  return import('./store');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucidssh-profile-sys-'));
  exeDir = mkdtempSync(join(tmpdir(), 'lucidssh-profile-exe-'));
});

afterEach(async () => {
  packaged = false;
  delete process.env[ENV];
  Object.defineProperty(process, 'platform', platformDesc);
  const { closeHostsDb } = await import('../hosts/db');
  closeHostsDb();
  const { closeHistoryDb } = await import('../history/db');
  closeHistoryDb();
  rmSync(dir, { recursive: true, force: true });
  rmSync(exeDir, { recursive: true, force: true });
});

describe('configDir — portable-сборка Windows', () => {
  it('настройки, обе БД, known_hosts и резервные копии создаются в каталоге exe; системный профиль нетронут', async () => {
    packaged = true;
    process.env[ENV] = exeDir;
    Object.defineProperty(process, 'platform', { value: 'win32' }); // portable-режим существует только на Windows, а CI гоняет тесты и на Linux

    const store = await freshStore();
    expect(store.configDir()).toBe(exeDir);

    store.loadConfig();
    store.updateConfig((cfg) => {
      cfg.language = 'en';
    });
    expect(existsSync(join(exeDir, 'config.json'))).toBe(true);

    const hosts = await import('../hosts/db');
    hosts.openHostsDb();
    expect(hosts.hostsDbPath()).toBe(join(exeDir, 'hosts.db'));
    expect(existsSync(hosts.hostsDbPath())).toBe(true);

    const history = await import('../history/db');
    history.openHistoryDb();
    expect(history.historyDbPath()).toBe(join(exeDir, 'history.db'));
    expect(existsSync(history.historyDbPath())).toBe(true);

    const { addKnownKey } = await import('../ssh/knownHosts');
    addKnownKey('203.0.113.7', 22, 'ssh-ed25519', Buffer.from('test-key'));
    expect(existsSync(join(exeDir, 'known_hosts'))).toBe(true);

    const { writePreUpdateBackup } = await import('../history/backups');
    writePreUpdateBackup(['config.json']);
    expect(readdirSync(join(exeDir, 'backups')).some((n) => n.startsWith('pre-update-'))).toBe(true);

    for (const name of ['config.json', 'hosts.db', 'history.db', 'known_hosts', 'backups']) {
      expect(existsSync(join(dir, name))).toBe(false);
    }
  });
});

describe('configDir — системный каталог сохраняется', () => {
  it('установленная сборка Windows (переменной нет) — userData', async () => {
    packaged = true;
    const store = await freshStore();
    expect(store.configDir()).toBe(dir);
  });

  it('dev и неупакованное приложение переменную игнорируют', async () => {
    packaged = false;
    process.env[ENV] = exeDir;
    const store = await freshStore();
    expect(store.configDir()).toBe(dir);
  });

  it('не-Windows платформа переменную игнорирует', async () => {
    packaged = true;
    process.env[ENV] = exeDir;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const store = await freshStore();
    expect(store.configDir()).toBe(dir);
  });

  it('пустая переменная профиль не меняет', async () => {
    packaged = true;
    process.env[ENV] = '';
    const store = await freshStore();
    expect(store.configDir()).toBe(dir);
  });
});
