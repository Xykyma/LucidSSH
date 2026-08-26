import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@shared/config';
import type { Host, HostInput } from '@shared/hosts';

// Ровно тот же принцип изоляции, что и в sessionManager.test.ts: seam ограничен
// __setClientFactoryForTest, hosts/repository и keychain подменяются напрямую —
// better-sqlite3/keytar/Electron тестам этого файла не нужны.
vi.mock('../hosts/repository', () => ({ getHost: vi.fn() }));
vi.mock('../keychain', () => ({ getSecretForConnection: vi.fn() }));
vi.mock('../config/store', () => ({ loadConfig: vi.fn() }));
// known_hosts читается с диска через configDir — тестам нужен только ответ
// «совпал / не совпал» для отпечатка bastion.
vi.mock('./knownHosts', () => ({ matchesKnownKey: vi.fn(() => true) }));
// Реального файла ключа в тестовом окружении нет — только один тест
// (authMethod: 'key' для bastion) задаёт непустой возврат.
vi.mock('./keys', () => ({
  loadPrivateKey: vi.fn(),
  PrivateKeyError: class PrivateKeyError extends Error {
    constructor(public readonly reason: string) {
      super(`private key error: ${reason}`);
    }
  }
}));

import { loadConfig } from '../config/store';
import { getSecretForConnection } from '../keychain';
import { getHost } from '../hosts/repository';
import { matchesKnownKey } from './knownHosts';
import { loadPrivateKey } from './keys';
import { testConnection, __setClientFactoryForTest, type FakeableTestClient } from './testConnection';

const mockLoadConfig = vi.mocked(loadConfig);
const mockGetSecretForConnection = vi.mocked(getSecretForConnection);
const mockGetHost = vi.mocked(getHost);
const mockMatchesKnownKey = vi.mocked(matchesKnownKey);
const mockLoadPrivateKey = vi.mocked(loadPrivateKey);

const fakeConfig = (): AppConfig =>
  ({
    connection: { autoreconnect: true, keepaliveIntervalSec: 30, connectTimeoutSec: 10 }
  }) as unknown as AppConfig;

const fakeInput = (overrides: Partial<HostInput> = {}): HostInput => ({
  name: 'prod-db',
  address: '10.0.1.20',
  port: 22,
  username: 'nikita',
  authMethod: 'password',
  guardEnabled: true,
  historyEnabled: true,
  ...overrides
});

const fakeBastion = (overrides: Partial<Host> = {}): Host => ({
  id: 7,
  name: 'bastion',
  address: '203.0.113.1',
  port: 22,
  username: 'nikita',
  authMethod: 'password',
  guardEnabled: true,
  historyEnabled: true,
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
  ...overrides
});

/** Фальшивый ssh2.Client (по образцу sessionManager.test.ts): копит
 *  обработчики on(event, …), позволяет тесту сымитировать события сервера
 *  без сети. `succeed: false` делает forwardOut отказным (bastion запрещает
 *  проброс). */
function makeFakeClient(opts: { forwardOutFails?: boolean } = {}): {
  client: FakeableTestClient;
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  forwardOut: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const connect = vi.fn();
  const end = vi.fn();
  const forwardOut = vi.fn(
    (
      _srcIP: string,
      _srcPort: number,
      _dstIP: string,
      _dstPort: number,
      cb: (err: Error | undefined, channel: unknown) => void
    ) => {
      if (opts.forwardOutFails) cb(new Error('forward denied'), undefined);
      else cb(undefined, { channel: true });
    }
  );
  const client = {
    connect,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return client;
    }),
    forwardOut,
    end
  } as unknown as FakeableTestClient;

  const emit = (event: string, ...args: unknown[]): void => {
    for (const handler of handlers.get(event) ?? []) handler(...args);
  };

  return { client, connect, end, forwardOut, emit };
}

describe('testConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(fakeConfig());
    mockMatchesKnownKey.mockReturnValue(true);
  });

  afterEach(() => {
    __setClientFactoryForTest(null);
  });

  it('без proxyJumpHostId: прямое подключение, ok при ready', async () => {
    const { client, end, emit } = makeFakeClient();
    __setClientFactoryForTest(() => client);

    const promise = testConnection(fakeInput(), 'pw');
    emit('ready');
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(end).toHaveBeenCalledTimes(1);
    expect(mockGetHost).not.toHaveBeenCalled();
  });

  it('без proxyJumpHostId: ошибка аутентификации — обычный errorKey, без step', async () => {
    const { client, emit } = makeFakeClient();
    __setClientFactoryForTest(() => client);

    const promise = testConnection(fakeInput(), 'wrong');
    emit('error', Object.assign(new Error('auth'), { level: 'client-authentication' }));
    emit('close');
    const result = await promise;

    expect(result).toEqual({ ok: false, errorKey: 'clog.error.auth' });
  });

  it('у bastion (пароль) нет сохранённого секрета — отказ без попытки подключения', async () => {
    mockGetHost.mockReturnValue(fakeBastion({ authMethod: 'password' }));
    mockGetSecretForConnection.mockResolvedValue(null);
    const factory = vi.fn();
    __setClientFactoryForTest(factory as unknown as () => FakeableTestClient);

    const result = await testConnection(fakeInput({ proxyJumpHostId: 7 }), 'target-secret');

    expect(result).toEqual({ ok: false, errorKey: 'clog.jump.hostSecretMissing', step: 'jump' });
    // Пустой пароль на реальный сервер не уходит — до сети дело не доходит.
    expect(factory).not.toHaveBeenCalled();
  });

  it('у bastion (ключ) нет сохранённого passphrase — легитимно, попытка идёт (незашифрованный ключ)', async () => {
    mockGetHost.mockReturnValue(fakeBastion({ authMethod: 'key', keyPath: 'C:\\keys\\id_ed25519' }));
    mockGetSecretForConnection.mockResolvedValue(null);
    mockLoadPrivateKey.mockReturnValue(Buffer.from('fake-key'));

    const { client, connect, emit } = makeFakeClient();
    __setClientFactoryForTest(() => client);

    const promise = testConnection(fakeInput({ proxyJumpHostId: 7 }), 'target-secret');
    await vi.waitFor(() => {
      if (connect.mock.calls.length === 0) throw new Error('bastion.connect ещё не вызван');
    });
    emit('error', Object.assign(new Error('auth'), { level: 'client-authentication' }));
    emit('close');

    // Не hostSecretMissing (та проверка касается только password-хостов) —
    // ключевой auth без passphrase такой же законный случай, как
    // незашифрованный приватный ключ; попытка подключения реально происходит.
    expect(await promise).toEqual({ ok: false, errorKey: 'clog.error.auth', step: 'jump' });
  });

  it('bastion недоступен: цепочка обрывается на первом хопе с step "jump"', async () => {
    mockGetHost.mockReturnValue(fakeBastion());
    mockGetSecretForConnection.mockResolvedValue('bastion-secret');

    const { client, connect, forwardOut, emit } = makeFakeClient();
    __setClientFactoryForTest(() => client);

    const promise = testConnection(fakeInput({ proxyJumpHostId: 7 }), 'target-secret');
    await vi.waitFor(() => {
      if (connect.mock.calls.length === 0) throw new Error('bastion.connect ещё не вызван');
    });
    emit('error', Object.assign(new Error('refused'), { level: undefined }));
    emit('close');
    const result = await promise;

    expect(result).toEqual({ ok: false, errorKey: 'clog.error.socket', step: 'jump' });
    // Второй хоп никогда не создаётся — factory вызвана только для bastion.
    expect(forwardOut).not.toHaveBeenCalled();
  });

  it('proxyJumpHostId ссылается на удалённый хост — ok:false, step "jump", без сети', async () => {
    mockGetHost.mockReturnValue(null);
    const factory = vi.fn();
    __setClientFactoryForTest(factory as unknown as () => FakeableTestClient);

    const result = await testConnection(fakeInput({ proxyJumpHostId: 99 }), 'target-secret');

    expect(result).toEqual({ ok: false, errorKey: 'clog.jump.hostMissing', step: 'jump' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('proxyJumpHostId указывает на сам редактируемый хост — self-reference, без сети', async () => {
    const factory = vi.fn();
    __setClientFactoryForTest(factory as unknown as () => FakeableTestClient);

    const result = await testConnection(fakeInput({ proxyJumpHostId: 3 }), 'target-secret', 3);

    expect(result).toEqual({ ok: false, errorKey: 'clog.jump.selfReference', step: 'jump' });
    expect(mockGetHost).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it('отпечаток bastion не в known_hosts — отказ до аутентификации, пароль не уходит', async () => {
    mockGetHost.mockReturnValue(fakeBastion());
    mockGetSecretForConnection.mockResolvedValue('bastion-secret');
    mockMatchesKnownKey.mockReturnValue(false);

    const { client, connect, emit } = makeFakeClient();
    __setClientFactoryForTest(() => client);

    const promise = testConnection(fakeInput({ proxyJumpHostId: 7 }), 'target-secret');
    await vi.waitFor(() => {
      if (connect.mock.calls.length === 0) throw new Error('bastion.connect ещё не вызван');
    });

    // ssh2 зовёт hostVerifier в рукопожатии, ДО отправки пароля (SSH-07):
    // отказ здесь означает, что секрет bastion серверу так и не достался.
    const config = connect.mock.calls[0]?.[0] as { hostVerifier: (key: Buffer) => boolean };
    expect(config.hostVerifier(Buffer.from('unknown-key'))).toBe(false);
    expect(mockMatchesKnownKey).toHaveBeenCalledWith('203.0.113.1', 22, expect.any(Buffer));

    emit('error', Object.assign(new Error('handshake failed'), { level: undefined }));
    emit('close');
    const result = await promise;

    // Не «сервер недоступен» — иначе пользователь чинил бы сеть вместо ключа.
    expect(result).toEqual({ ok: false, errorKey: 'clog.jump.hostkeyUnknown', step: 'jump' });
  });

  it('отпечаток bastion известен — цепочка идёт дальше', async () => {
    mockGetHost.mockReturnValue(fakeBastion());
    mockGetSecretForConnection.mockResolvedValue('bastion-secret');

    const jump = makeFakeClient();
    const target = makeFakeClient();
    const clients = [jump.client, target.client];
    __setClientFactoryForTest(() => clients.shift() as FakeableTestClient);

    const promise = testConnection(fakeInput({ proxyJumpHostId: 7 }), 'target-secret');
    await vi.waitFor(() => {
      if (jump.connect.mock.calls.length === 0) throw new Error('bastion.connect ещё не вызван');
    });

    const jumpConfig = jump.connect.mock.calls[0]?.[0] as {
      hostVerifier: (key: Buffer) => boolean;
    };
    expect(jumpConfig.hostVerifier(Buffer.from('known-key'))).toBe(true);

    jump.emit('ready');
    await vi.waitFor(() => {
      if (target.connect.mock.calls.length === 0) throw new Error('target.connect ещё не вызван');
    });
    target.emit('ready');

    expect(await promise).toEqual({ ok: true });
  });

  it('целевой хост отпечаток не сверяет — поведение старше jump-хостов, не трогаем', async () => {
    const { client, connect, emit } = makeFakeClient();
    __setClientFactoryForTest(() => client);

    const promise = testConnection(fakeInput(), 'pw');
    const config = connect.mock.calls[0]?.[0] as { hostVerifier: (key: Buffer) => boolean };

    expect(config.hostVerifier(Buffer.from('any-key'))).toBe(true);
    expect(mockMatchesKnownKey).not.toHaveBeenCalled();

    emit('ready');
    await promise;
  });

  it('bastion ok, target недоступен: ошибка без step "jump" — она про целевой хост', async () => {
    mockGetHost.mockReturnValue(fakeBastion());
    mockGetSecretForConnection.mockResolvedValue('bastion-secret');

    const jump = makeFakeClient();
    const target = makeFakeClient();
    const clients = [jump.client, target.client];
    __setClientFactoryForTest(() => clients.shift() as FakeableTestClient);

    const promise = testConnection(fakeInput({ proxyJumpHostId: 7 }), 'target-secret');

    // Bastion аутентифицируется успешно первым.
    await vi.waitFor(() => {
      if (jump.connect.mock.calls.length === 0) throw new Error('bastion.connect ещё не вызван');
    });
    jump.emit('ready');

    // Затем целевой Client получает sock через forwardOut и падает по паролю.
    await vi.waitFor(() => {
      if (target.connect.mock.calls.length === 0) throw new Error('target.connect ещё не вызван');
    });
    target.emit('error', Object.assign(new Error('auth'), { level: 'client-authentication' }));
    target.emit('close');

    const result = await promise;

    expect(result).toEqual({ ok: false, errorKey: 'clog.error.auth' });
    expect(jump.forwardOut).toHaveBeenCalledWith('127.0.0.1', 0, '10.0.1.20', 22, expect.any(Function));
    // Bastion закрывается после того, как цепочка отработала (успешно или нет).
    expect(jump.end).toHaveBeenCalledTimes(1);
  });

  it('bastion разрешает проброс, но forwardOut отказывает — ok:false, step "jump"', async () => {
    mockGetHost.mockReturnValue(fakeBastion());
    mockGetSecretForConnection.mockResolvedValue('bastion-secret');

    const { client, connect, end, emit } = makeFakeClient({ forwardOutFails: true });
    __setClientFactoryForTest(() => client);

    const promise = testConnection(fakeInput({ proxyJumpHostId: 7 }), 'target-secret');
    await vi.waitFor(() => {
      if (connect.mock.calls.length === 0) throw new Error('bastion.connect ещё не вызван');
    });
    emit('ready');
    const result = await promise;

    expect(result).toEqual({ ok: false, errorKey: 'clog.jump.tunnelFailed', step: 'jump' });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('сквозной успешный проход через bastion — ok:true, оба Client закрыты', async () => {
    mockGetHost.mockReturnValue(fakeBastion());
    mockGetSecretForConnection.mockResolvedValue('bastion-secret');

    const jump = makeFakeClient();
    const target = makeFakeClient();
    const clients = [jump.client, target.client];
    __setClientFactoryForTest(() => clients.shift() as FakeableTestClient);

    const promise = testConnection(fakeInput({ proxyJumpHostId: 7 }), 'target-secret');

    await vi.waitFor(() => {
      if (jump.connect.mock.calls.length === 0) throw new Error('bastion.connect ещё не вызван');
    });
    jump.emit('ready');

    await vi.waitFor(() => {
      if (target.connect.mock.calls.length === 0) throw new Error('target.connect ещё не вызван');
    });
    target.emit('ready');

    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(jump.end).toHaveBeenCalledTimes(1);
    expect(target.end).toHaveBeenCalledTimes(1);
    // connect() целевого Client получил sock от forwardOut, а не прямой TCP.
    const targetConfig = target.connect.mock.calls[0]?.[0] as { sock?: unknown };
    expect(targetConfig.sock).toEqual({ channel: true });
  });
});
