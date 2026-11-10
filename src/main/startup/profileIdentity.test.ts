import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Постоянная идентичность Переносимого профиля (NFR-05, тикет 02): `profile.id`
 * создаётся при первом запуске portable-сборки и переживает перезапуски, перенос
 * папки и замену exe; отсутствие или повреждение ID рядом с любыми данными
 * LucidSSH блокирует запуск без регенерации и записи. Системный профиль
 * установленной версии и dev идентичность не получают. Тот же приём мока
 * electron и реальной временной ФС, что в config/profileDir.test.ts.
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

function freshIdentity(): Promise<typeof import('./profileIdentity')> {
  vi.resetModules();
  return import('./profileIdentity');
}

/** Portable-окружение: упакованная Windows-сборка, переменная указывает на exeDir. */
function portableEnv(): void {
  packaged = true;
  process.env[ENV] = exeDir;
  Object.defineProperty(process, 'platform', { value: 'win32' });
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucidssh-identity-sys-'));
  exeDir = mkdtempSync(join(tmpdir(), 'lucidssh-identity-exe-'));
});

afterEach(() => {
  packaged = false;
  delete process.env[ENV];
  Object.defineProperty(process, 'platform', platformDesc);
  rmSync(dir, { recursive: true, force: true });
  rmSync(exeDir, { recursive: true, force: true });
});

describe('prepareProfileIdentity — не portable', () => {
  it('dev переменную игнорирует: идентичность не нужна, profile.id нигде не создаётся', async () => {
    process.env[ENV] = exeDir;
    const identity = await freshIdentity();
    expect(identity.prepareProfileIdentity()).toEqual({ ok: true, profileId: null });
    expect(identity.getProfileId()).toBeNull();
    expect(existsSync(join(exeDir, 'profile.id'))).toBe(false);
    expect(existsSync(join(dir, 'profile.id'))).toBe(false);
  });

  it('установленная сборка и не-Windows платформа идентичность не получают', async () => {
    packaged = true;
    const identity = await freshIdentity();
    expect(identity.prepareProfileIdentity()).toEqual({ ok: true, profileId: null });

    process.env[ENV] = exeDir;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.resetModules();
    const linux = await import('./profileIdentity');
    expect(linux.prepareProfileIdentity()).toEqual({ ok: true, profileId: null });
  });
});

describe('prepareProfileIdentity — новый профиль', () => {
  it('пустая папка: profile.id создаётся атомарно (без .tmp-остатков) и это единственный созданный файл', async () => {
    portableEnv();
    const identity = await freshIdentity();
    const res = identity.prepareProfileIdentity();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.profileId).toMatch(UUID_V4_RE);
      expect(identity.getProfileId()).toBe(res.profileId);
    }
    expect(readdirSync(exeDir)).toEqual(['profile.id']);
    expect(existsSync(join(exeDir, 'profile.id.tmp'))).toBe(false);
  });

  it('сам exe и посторонние файлы папку существующим профилем не делают', async () => {
    portableEnv();
    writeFileSync(join(exeDir, 'LucidSSH-Portable-1.2.3-test-x64.exe'), Buffer.from('MZ'));
    writeFileSync(join(exeDir, 'readme.txt'), 'заметки');
    const identity = await freshIdentity();
    const res = identity.prepareProfileIdentity();
    expect(res.ok).toBe(true);
    expect(readdirSync(exeDir).sort()).toEqual(['LucidSSH-Portable-1.2.3-test-x64.exe', 'profile.id', 'readme.txt']);
  });

  it('не удалось создать файл (путь профиля занят обычным файлом) — createFailed без остатков', async () => {
    portableEnv();
    // configDir() указывает на обычный файл: mkdir/запись невозможны, папки нет.
    process.env[ENV] = join(exeDir, 'blocker');
    writeFileSync(process.env[ENV], 'x');
    const identity = await freshIdentity();
    expect(identity.prepareProfileIdentity()).toEqual({ ok: false, error: 'createFailed' });
    expect(existsSync(join(exeDir, 'blocker', 'profile.id'))).toBe(false);
  });
});

describe('prepareProfileIdentity — существующий профиль', () => {
  it('повторный запуск читает тот же ID из файла', async () => {
    portableEnv();
    const first = await freshIdentity();
    const created = first.prepareProfileIdentity();
    expect(created.ok).toBe(true);

    vi.resetModules();
    const second = await import('./profileIdentity');
    const reread = second.prepareProfileIdentity();
    expect(reread).toEqual(created);
  });

  it('перенос папки: тот же ID после «переезда» в новое расположение', async () => {
    portableEnv();
    const first = await freshIdentity();
    const created = first.prepareProfileIdentity();
    const file = join(exeDir, 'profile.id');

    const moved = mkdtempSync(join(tmpdir(), 'lucidssh-identity-moved-'));
    try {
      writeFileSync(join(moved, 'profile.id'), readFileSync(file, 'utf8'));
      process.env[ENV] = moved;
      vi.resetModules();
      const movedMod = await import('./profileIdentity');
      expect(movedMod.prepareProfileIdentity()).toEqual(created);
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });

  it('ID в верхнем регистре принимается, в работу берётся нижний, файл не перезаписывается', async () => {
    portableEnv();
    const upper = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    writeFileSync(join(exeDir, 'profile.id'), upper, 'utf8');
    const identity = await freshIdentity();
    const res = identity.prepareProfileIdentity();
    expect(res).toEqual({ ok: true, profileId: upper.toLowerCase() });
    expect(readFileSync(join(exeDir, 'profile.id'), 'utf8')).toBe(upper);
  });

  it('сброс Настроек не затрагивает profile.id', async () => {
    portableEnv();
    const identity = await freshIdentity();
    const created = identity.prepareProfileIdentity();
    const { resetConfig } = await import('../config/store');
    resetConfig();
    vi.resetModules();
    const after = await import('./profileIdentity');
    expect(after.prepareProfileIdentity()).toEqual(created);
  });

  it('повреждённый config.json при валидном ID не меняет идентичность; настройки падают на дефолт', async () => {
    portableEnv();
    const identity = await freshIdentity();
    const created = identity.prepareProfileIdentity();
    writeFileSync(join(exeDir, 'config.json'), '{не json', 'utf8');

    const { loadConfig } = await import('../config/store');
    expect(loadConfig().language).toBe('ru'); // дефолт, а не падение

    vi.resetModules();
    const after = await import('./profileIdentity');
    expect(after.prepareProfileIdentity()).toEqual(created);
  });
});

describe('prepareProfileIdentity — повреждённая идентичность блокирует запуск', () => {
  /** Каждый известный артефакт данных без profile.id — отказ без записи. */
  const artifactCases: Array<[string, (folder: string) => void]> = [
    ['config.json', (f) => writeFileSync(join(f, 'config.json'), '{}')],
    ['hosts.db', (f) => writeFileSync(join(f, 'hosts.db'), 'sqlite')],
    ['history.db', (f) => writeFileSync(join(f, 'history.db'), 'sqlite')],
    ['known_hosts', (f) => writeFileSync(join(f, 'known_hosts'), 'host key')],
    ['backups/', (f) => mkdirSync(join(f, 'backups'))],
    ['hosts.db.backup-v3', (f) => writeFileSync(join(f, 'hosts.db.backup-v3'), 'sqlite')],
    ['history.db.backup-v2', (f) => writeFileSync(join(f, 'history.db.backup-v2'), 'sqlite')]
  ];

  it.each(artifactCases)('артефакт %s без profile.id — artifactsWithoutId, новый ID не создаётся', async (_name, seed) => {
    portableEnv();
    seed(exeDir);
    const before = readdirSync(exeDir);
    const identity = await freshIdentity();
    expect(identity.prepareProfileIdentity()).toEqual({ ok: false, error: 'artifactsWithoutId' });
    expect(identity.getProfileId()).toBeNull();
    expect(readdirSync(exeDir).sort()).toEqual(before.sort());
  });

  it.each([
    ['пустой файл', ''],
    ['текст-не-UUID', 'not-a-uuid'],
    ['нулевой UUID (невалидная версия)', '00000000-0000-0000-0000-000000000000'],
    ['UUID без дефисов', 'a0b1c2d3e4f5061728394a5b6c7d8e9f'],
    ['несколько строк', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\nbbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']
  ])('%s — invalidId, файл и данные не трогаются', async (_name, content) => {
    portableEnv();
    writeFileSync(join(exeDir, 'profile.id'), content, 'utf8');
    writeFileSync(join(exeDir, 'config.json'), '{}');
    const identity = await freshIdentity();
    expect(identity.prepareProfileIdentity()).toEqual({ ok: false, error: 'invalidId' });
    expect(readFileSync(join(exeDir, 'profile.id'), 'utf8')).toBe(content);
    expect(readFileSync(join(exeDir, 'config.json'), 'utf8')).toBe('{}');
  });

  it('profile.id вместо файла — каталог: файл не читается, invalidId', async () => {
    portableEnv();
    mkdirSync(join(exeDir, 'profile.id'));
    const identity = await freshIdentity();
    expect(identity.prepareProfileIdentity()).toEqual({ ok: false, error: 'invalidId' });
  });
});
