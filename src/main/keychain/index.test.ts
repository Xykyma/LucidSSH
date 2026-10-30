import { beforeEach, describe, expect, it, vi } from 'vitest';

const keytar = {
  setPassword: vi.fn(),
  getPassword: vi.fn(),
  deletePassword: vi.fn()
};

// resetModules пересоздаёт и класс ошибки — берём его из того же графа, что и keychain.
async function loadKeychain(): Promise<typeof import('./index') & { Err: new () => Error }> {
  vi.resetModules();
  const k = await import('./index');
  const { SecretStoreUnavailableError: Err } = await import('./errors');
  return { ...k, Err };
}

describe('keychain — доступное Хранилище секретов', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.doMock('keytar', () => ({ default: keytar }));
  });

  it('setSecret/getSecretForConnection/hasSecret/deleteSecret ходят в keytar под LucidSSH/{id}', async () => {
    keytar.getPassword.mockResolvedValue('pw');
    const k = await loadKeychain();

    await k.setSecret(3, 'pw');
    expect(keytar.setPassword).toHaveBeenCalledWith('LucidSSH', '3', 'pw');
    expect(await k.getSecretForConnection(3)).toBe('pw');
    expect(await k.hasSecret(3)).toBe(true);
    await k.deleteSecret(3);
    expect(keytar.deletePassword).toHaveBeenCalledWith('LucidSSH', '3');
  });

  it('hasSecret: пусто → false', async () => {
    keytar.getPassword.mockResolvedValue(null);
    expect(await (await loadKeychain()).hasSecret(1)).toBe(false);
  });

  it.each(['setSecret', 'getSecretForConnection', 'hasSecret', 'deleteSecret'] as const)(
    '%s: сбой вызова keytar → SecretStoreUnavailableError',
    async (fn) => {
      const boom = new Error('org.freedesktop.secrets not available');
      keytar.setPassword.mockRejectedValue(boom);
      keytar.getPassword.mockRejectedValue(boom);
      keytar.deletePassword.mockRejectedValue(boom);
      const k = await loadKeychain();

      const call = fn === 'setSecret' ? k.setSecret(1, 'x') : k[fn](1);
      await expect(call).rejects.toBeInstanceOf(k.Err);
    }
  );
});

describe('keychain — keytar не загружается (нет libsecret)', () => {
  beforeEach(() => {
    vi.doMock('keytar', () => {
      throw new Error('libsecret-1.so.0: cannot open shared object file');
    });
  });

  it('импорт модуля не падает', async () => {
    await expect(loadKeychain()).resolves.toBeDefined();
  });

  it('вызов → SecretStoreUnavailableError, а не сырая ошибка загрузки', async () => {
    const k = await loadKeychain();
    await expect(k.hasSecret(1)).rejects.toBeInstanceOf(k.Err);
    await expect(k.setSecret(1, 'x')).rejects.toBeInstanceOf(k.Err);
  });

  it('текст ошибки не содержит секрета', async () => {
    const k = await loadKeychain();
    const err = await k.setSecret(1, 'hunter2').catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain('hunter2');
  });
});
