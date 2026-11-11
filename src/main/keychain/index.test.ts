import { beforeEach, describe, expect, it, vi } from 'vitest';

const keytar = {
  setPassword: vi.fn(),
  getPassword: vi.fn(),
  deletePassword: vi.fn()
};

// keychain берёт profileId только отсюда (тикет 04): null — установленная
// версия и другие платформы, адрес записи LucidSSH/{hostId}; строка —
// portable-профиль, адрес LucidSSH/{profileId}/{credentialId}.
let profileId: string | null = null;

vi.doMock('../startup/profileIdentity', () => ({ getProfileId: () => profileId }));

// resetModules пересоздаёт и класс ошибки — берём его из того же графа, что и keychain.
async function loadKeychain(): Promise<typeof import('./index') & { Err: new () => Error }> {
  vi.resetModules();
  const k = await import('./index');
  const { SecretStoreUnavailableError: Err } = await import('./errors');
  return { ...k, Err };
}

const CRED = { hostId: 3, credentialId: 'cred-3' };

describe('keychain — доступное Хранилище секретов', () => {
  beforeEach(() => {
    profileId = null;
    vi.clearAllMocks();
    vi.doMock('keytar', () => ({ default: keytar }));
  });

  it('установленная версия: операции ходят в keytar под прежним LucidSSH/{hostId}', async () => {
    keytar.getPassword.mockResolvedValue('pw');
    const k = await loadKeychain();

    await k.setSecret(CRED, 'pw');
    expect(keytar.setPassword).toHaveBeenCalledWith('LucidSSH', '3', 'pw');
    expect(await k.getSecretForConnection(CRED)).toBe('pw');
    expect(await k.hasSecret(CRED)).toBe(true);
    await k.deleteSecret(CRED);
    expect(keytar.deletePassword).toHaveBeenCalledWith('LucidSSH', '3');
  });

  it('portable-профиль: адрес записи — profileId/credentialId', async () => {
    profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    keytar.getPassword.mockResolvedValue('pw');
    const k = await loadKeychain();

    await k.setSecret(CRED, 'pw');
    expect(keytar.setPassword).toHaveBeenCalledWith(
      'LucidSSH',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cred-3',
      'pw'
    );
    expect(await k.getSecretForConnection(CRED)).toBe('pw');
    await k.deleteSecret(CRED);
    expect(keytar.deletePassword).toHaveBeenCalledWith(
      'LucidSSH',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cred-3'
    );
  });

  it('одинаковый hostId при разных идентичностях адресует разные записи', async () => {
    profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const k = await loadKeychain();

    await k.setSecret({ hostId: 7, credentialId: 'cred-a' }, 'a');
    profileId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await k.setSecret({ hostId: 7, credentialId: 'cred-b' }, 'b');

    const accounts = keytar.setPassword.mock.calls.map((c) => c[1]);
    expect(accounts).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cred-a',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/cred-b'
    ]);
  });

  it('hasSecret: пусто → false', async () => {
    keytar.getPassword.mockResolvedValue(null);
    expect(await (await loadKeychain()).hasSecret(CRED)).toBe(false);
  });

  it.each(['setSecret', 'getSecretForConnection', 'hasSecret', 'deleteSecret'] as const)(
    '%s: сбой вызова keytar → SecretStoreUnavailableError',
    async (fn) => {
      const boom = new Error('org.freedesktop.secrets not available');
      keytar.setPassword.mockRejectedValue(boom);
      keytar.getPassword.mockRejectedValue(boom);
      keytar.deletePassword.mockRejectedValue(boom);
      const k = await loadKeychain();

      const call = fn === 'setSecret' ? k.setSecret(CRED, 'x') : k[fn](CRED);
      await expect(call).rejects.toBeInstanceOf(k.Err);
    }
  );
});

describe('keychain — keytar не загружается (нет libsecret)', () => {
  beforeEach(() => {
    profileId = null;
    vi.doMock('keytar', () => {
      throw new Error('libsecret-1.so.0: cannot open shared object file');
    });
  });

  it('импорт модуля не падает', async () => {
    await expect(loadKeychain()).resolves.toBeDefined();
  });

  it('вызов → SecretStoreUnavailableError, а не сырая ошибка загрузки', async () => {
    const k = await loadKeychain();
    await expect(k.hasSecret(CRED)).rejects.toBeInstanceOf(k.Err);
    await expect(k.setSecret(CRED, 'x')).rejects.toBeInstanceOf(k.Err);
  });

  it('текст ошибки не содержит секрета', async () => {
    const k = await loadKeychain();
    const err = await k.setSecret(CRED, 'hunter2').catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain('hunter2');
  });
});
