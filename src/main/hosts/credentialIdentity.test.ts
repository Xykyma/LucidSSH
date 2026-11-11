import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Идентичность секрета хоста и адресация Хранилища (NFR-05, тикет 04) через
 * реальные временные БД, публичные операции Хранилища и подменённый keytar
 * (карта в памяти — изоляция проверяется по значениям, а не по аргументам
 * вызовов). Профиль — управляемый profileId: null — «установленная» адресация
 * LucidSSH/{hostId}, строка — portable LucidSSH/{profileId}/{credentialId}.
 */

let dir = '';
let profileId: string | null = null;

vi.mock('electron', () => ({
  app: {
    getPath: () => dir,
    getVersion: () => '1.2.3-test'
  }
}));

vi.mock('../startup/profileIdentity', () => ({ getProfileId: () => profileId }));

const store = new Map<string, string>();
const keytar = {
  setPassword: vi.fn((service: string, account: string, password: string) => {
    store.set(`${service}:${account}`, password);
    return Promise.resolve();
  }),
  getPassword: vi.fn((service: string, account: string) =>
    Promise.resolve(store.get(`${service}:${account}`) ?? null)
  ),
  deletePassword: vi.fn((service: string, account: string) => {
    store.delete(`${service}:${account}`);
    return Promise.resolve(true);
  })
};

async function freshModules(): Promise<{
  repo: typeof import('./repository');
  keychain: typeof import('../keychain');
  Err: new () => Error;
}> {
  vi.resetModules();
  vi.doMock('keytar', () => ({ default: keytar }));
  const repo = await import('./repository');
  const keychain = await import('../keychain');
  const { SecretStoreUnavailableError: Err } = await import('../keychain/errors');
  return { repo, keychain, Err };
}

async function closeDb(): Promise<void> {
  const { closeHostsDb } = await import('./db');
  closeHostsDb();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucidssh-cred-id-'));
  profileId = null;
  store.clear();
  vi.clearAllMocks();
});

afterEach(async () => {
  await closeDb();
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

describe('адресация Хранилища секретов (тикет 04)', () => {
  it('установленная версия: прежний адрес LucidSSH/{hostId}, записи Хранилища не мигрируют', async () => {
    const { repo, keychain } = await freshModules();
    const id = repo.createHost({ ...base, name: 'web-01' });
    const cred = repo.getHostCredential(id)!;

    await keychain.setSecret(cred, 'pw');
    expect(keytar.setPassword).toHaveBeenCalledWith('LucidSSH', String(id), 'pw');
    expect(await keychain.getSecretForConnection(cred)).toBe('pw');

    await keychain.deleteSecret(cred);
    expect(await keychain.hasSecret(cred)).toBe(false);
  });

  it('portable: адрес записи включает profileId + credentialId', async () => {
    profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const { repo, keychain } = await freshModules();
    const cred = repo.getHostCredential(repo.createHost({ ...base, name: 'web-01' }))!;

    await keychain.setSecret(cred, 'pw');
    expect(keytar.setPassword).toHaveBeenCalledWith(
      'LucidSSH',
      `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${cred.credentialId}`,
      'pw'
    );
    expect(await keychain.getSecretForConnection(cred)).toBe('pw');
  });

  it('одинаковый числовой ID в установленном и portable-профиле адресует разные записи', async () => {
    const { repo, keychain } = await freshModules();
    const cred = repo.getHostCredential(repo.createHost({ ...base, name: 'web-01' }))!;

    await keychain.setSecret(cred, 'installed-pw');
    profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(await keychain.getSecretForConnection(cred)).toBeNull();

    await keychain.setSecret(cred, 'portable-pw');
    profileId = null;
    expect(await keychain.getSecretForConnection(cred)).toBe('installed-pw');
  });

  it('два разных portable-профиля изолируют записи', async () => {
    profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const { repo, keychain } = await freshModules();
    const cred = repo.getHostCredential(repo.createHost({ ...base, name: 'web-01' }))!;
    await keychain.setSecret(cred, 'pw-a');

    profileId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    expect(await keychain.getSecretForConnection(cred)).toBeNull();
    await keychain.setSecret(cred, 'pw-b');
    expect(await keychain.getSecretForConnection(cred)).toBe('pw-b');

    profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(await keychain.getSecretForConnection(cred)).toBe('pw-a');
  });

  it('скопированная БД на том же ПК: идентичность и общий секрет сохраняются', async () => {
    profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let mods = await freshModules();
    const id = mods.repo.createHost({ ...base, name: 'web-01' });
    const cred = mods.repo.getHostCredential(id)!;
    await mods.keychain.setSecret(cred, 'shared-pw');

    await closeDb();
    const originalDir = dir;
    const copyDir = mkdtempSync(join(tmpdir(), 'lucidssh-cred-copy-'));
    try {
      // «Перенос папки»: копия БД в новом расположении, тот же ПК и profileId
      for (const name of readdirSync(originalDir)) {
        if (name === 'hosts.db' || name.startsWith('hosts.db-')) {
          copyFileSync(join(originalDir, name), join(copyDir, name));
        }
      }
      dir = copyDir;
      mods = await freshModules();

      const copied = mods.repo.getHostCredential(id)!;
      expect(copied).toEqual(cred);
      expect(await mods.keychain.getSecretForConnection(copied)).toBe('shared-pw');

      // Изменение только секрета обновляет общий секрет всех копий
      await mods.keychain.setSecret(copied, 'shared-pw-2');
      expect(await mods.keychain.getSecretForConnection(cred)).toBe('shared-pw-2');

      // Удаление скопированного хоста — общее правило для всех копий:
      // общая запись удаляется, обе стороны теряют доступ к секрету
      await mods.keychain.deleteSecret(copied);
      expect(await mods.keychain.getSecretForConnection(cred)).toBeNull();
      expect(await mods.keychain.getSecretForConnection(copied)).toBeNull();
    } finally {
      await closeDb();
      dir = originalDir;
      rmSync(copyDir, { recursive: true, force: true });
    }
  });

  it('независимо созданные хосты с одинаковым числовым ID имеют изолированные секреты', async () => {
    profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let mods = await freshModules();
    const idA = mods.repo.createHost({ ...base, name: 'web-01' });
    expect(idA).toBe(1);
    const credA = mods.repo.getHostCredential(idA)!;
    await mods.keychain.setSecret(credA, 'pw-a');

    // Другая папка: SQLite независимо назначает новому хосту тот же id 1
    await closeDb();
    const originalDir = dir;
    const otherDir = mkdtempSync(join(tmpdir(), 'lucidssh-cred-other-'));
    try {
      dir = otherDir;
      mods = await freshModules();
      const idB = mods.repo.createHost({ ...base, name: 'other-host' });
      expect(idB).toBe(1);
      const credB = mods.repo.getHostCredential(idB)!;
      expect(credB.credentialId).not.toBe(credA.credentialId);

      // Не читают, не перезаписывают и не удаляют записи друг друга
      expect(await mods.keychain.getSecretForConnection(credB)).toBeNull();
      await mods.keychain.setSecret(credB, 'pw-b');
      expect(await mods.keychain.getSecretForConnection(credB)).toBe('pw-b');
      await mods.keychain.deleteSecret(credB);
      expect(await mods.keychain.getSecretForConnection(credB)).toBeNull();
    } finally {
      await closeDb();
      dir = originalDir;
      rmSync(otherDir, { recursive: true, force: true });
    }

    mods = await freshModules();
    expect(await mods.keychain.getSecretForConnection(credA)).toBe('pw-a');
  });

  it('отказ Хранилища — SecretStoreUnavailableError; секрет не пишется в файлы профиля', async () => {
    profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const { repo, keychain, Err } = await freshModules();
    const cred = repo.getHostCredential(repo.createHost({ ...base, name: 'web-01' }))!;

    keytar.setPassword.mockRejectedValueOnce(new Error('org.freedesktop.secrets not available'));
    await expect(keychain.setSecret(cred, 's3cr3t-value')).rejects.toBeInstanceOf(Err);

    for (const name of readdirSync(dir)) {
      expect(readFileSync(join(dir, name)).toString('latin1')).not.toContain('s3cr3t-value');
    }
  });
});
