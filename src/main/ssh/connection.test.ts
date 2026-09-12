import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@shared/config';

// hostKeyDecision мокается, как в testConnection.test.ts — нужно управлять
// моментом verify() независимо от промпта (PR-2 спеки, `.scratch/open-connection/spec.md`).
vi.mock('./hostKeyDecision', () => ({
  requestHostKeyDecision: vi.fn(),
  HOSTKEY_DECISION_TIMEOUT_MS: 300_000
}));
vi.mock('../config/store', () => ({ loadConfig: vi.fn() }));

import { loadConfig } from '../config/store';
import { requestHostKeyDecision, type RequestHostKeyDecisionParams } from './hostKeyDecision';
import { openConnection, __setConnectionFactoryForTest, type ConnectionTarget } from './connection';
import { makeFakeConnection } from './fakeConnection';

const mockLoadConfig = vi.mocked(loadConfig);
const mockRequestHostKeyDecision = vi.mocked(requestHostKeyDecision);

const fakeConfig = (): AppConfig =>
  ({
    connection: { autoreconnect: true, keepaliveIntervalSec: 30, connectTimeoutSec: 10 }
  }) as unknown as AppConfig;

const target: ConnectionTarget = {
  name: 'web-01',
  address: '10.0.0.5',
  port: 22,
  username: 'nikita'
};

/** По умолчанию решение принимается немедленно как «ключ совпал» — большинству
 *  тестов сама сверка отпечатка не интересна. */
function autoAcceptHostKey(): void {
  mockRequestHostKeyDecision.mockImplementation(({ verify }: RequestHostKeyDecisionParams) => verify(true));
}

describe('openConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(fakeConfig());
    autoAcceptHostKey();
  });

  afterEach(() => {
    __setConnectionFactoryForTest(null);
  });

  it('ручка доступна синхронно, до ready', () => {
    const { connection } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);

    const { connection: handle, outcome } = openConnection(target, { kind: 'password', password: 'pw' }, {
      purpose: 'session'
    });

    expect(handle).toBe(connection);
    expect(outcome).toBeInstanceOf(Promise);
  });

  it('ready → outcome { ok: true }', async () => {
    const { connection, emit } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);

    const { outcome } = openConnection(target, { kind: 'password', password: 'pw' }, { purpose: 'session' });
    emit('ready');

    expect(await outcome).toEqual({ ok: true });
  });

  it('close без единой ошибки → socket', async () => {
    const { connection, emit } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);

    const { outcome } = openConnection(target, { kind: 'password', password: 'pw' }, { purpose: 'session' });
    emit('close');

    expect(await outcome).toEqual({ ok: false, reason: 'socket' });
  });

  it('error без close не разрешает outcome', async () => {
    const { connection, emit } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);

    const { outcome } = openConnection(target, { kind: 'password', password: 'pw' }, { purpose: 'session' });
    emit('error', Object.assign(new Error('auth'), { level: 'client-authentication' }));

    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    emit('close');
    expect(await outcome).toEqual({ ok: false, reason: 'auth' });
  });

  it('error level client-authentication → close → auth', async () => {
    const { connection, emit } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);

    const { outcome } = openConnection(target, { kind: 'password', password: 'pw' }, { purpose: 'session' });
    emit('error', Object.assign(new Error('auth'), { level: 'client-authentication' }));
    emit('close');

    expect(await outcome).toEqual({ ok: false, reason: 'auth' });
  });

  it('error level client-timeout → close → timeout', async () => {
    const { connection, emit } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);

    const { outcome } = openConnection(target, { kind: 'password', password: 'pw' }, { purpose: 'session' });
    emit('error', Object.assign(new Error('timed out'), { level: 'client-timeout' }));
    emit('close');

    expect(await outcome).toEqual({ ok: false, reason: 'timeout' });
  });

  it('error без level (сетевая) → close → socket', async () => {
    const { connection, emit } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);

    const { outcome } = openConnection(target, { kind: 'password', password: 'pw' }, { purpose: 'session' });
    emit('error', Object.assign(new Error('refused'), { level: undefined }));
    emit('close');

    expect(await outcome).toEqual({ ok: false, reason: 'socket' });
  });

  it('отказ по ключу (reject) → hostkey-rejected, приоритет над последующей error/close', async () => {
    mockRequestHostKeyDecision.mockImplementation(({ verify }) => verify(false));
    const { connection, emit } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);

    const { connection: handle, outcome } = openConnection(
      target,
      { kind: 'password', password: 'pw' },
      { purpose: 'session' }
    );
    const connectConfig = vi.mocked(handle.connect).mock.calls[0]?.[0] as unknown as {
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => void;
    };
    const verifySpy = vi.fn();
    connectConfig.hostVerifier(Buffer.from('key'), verifySpy);
    expect(verifySpy).toHaveBeenCalledWith(false);

    // ssh2 сообщает отказ по ключу обычной ошибкой соединения (level
    // 'handshake') — приоритет решения 8 спеки: hostkey-rejected остаётся
    // причиной, а не socket от последовавшей ошибки.
    emit('error', Object.assign(new Error('Host denied (verification failed)'), { level: 'handshake' }));
    emit('close');

    expect(await outcome).toEqual({ ok: false, reason: 'hostkey-rejected' });
  });

  it('таймаут решения по ключу (verify(false) от hostKeyDecision) → hostkey-rejected', async () => {
    mockRequestHostKeyDecision.mockImplementation(({ verify }) => {
      // Имитация HOSTKEY_DECISION_TIMEOUT_MS — verify(false) без промпта.
      verify(false);
    });
    const { connection, emit } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);

    const { connection: handle, outcome } = openConnection(
      target,
      { kind: 'password', password: 'pw' },
      { purpose: 'session' }
    );
    const connectConfig = vi.mocked(handle.connect).mock.calls[0]?.[0] as unknown as {
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => void;
    };
    connectConfig.hostVerifier(Buffer.from('key'), vi.fn());
    emit('close');

    expect(await outcome).toEqual({ ok: false, reason: 'hostkey-rejected' });
  });

  it('auth приоритетнее просто socket, если обе ошибки случились до close', async () => {
    const { connection, emit } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);

    const { outcome } = openConnection(target, { kind: 'password', password: 'pw' }, { purpose: 'session' });
    emit('error', Object.assign(new Error('refused'), { level: undefined }));
    emit('error', Object.assign(new Error('auth'), { level: 'client-authentication' }));
    emit('close');

    expect(await outcome).toEqual({ ok: false, reason: 'auth' });
  });

  it('hostVerifier всегда уходит в requestHostKeyDecision с purpose/logger; ready не наступает до verify', () => {
    let capturedVerify: ((valid: boolean) => void) | undefined;
    mockRequestHostKeyDecision.mockImplementation(({ verify }) => {
      capturedVerify = verify;
    });
    const { connection } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);

    const logger = vi.fn();
    const { connection: handle } = openConnection(
      target,
      { kind: 'password', password: 'pw' },
      { purpose: 'test', logger }
    );
    const connectConfig = vi.mocked(handle.connect).mock.calls[0]?.[0] as unknown as {
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => void;
    };
    connectConfig.hostVerifier(Buffer.from('key'), vi.fn());

    expect(mockRequestHostKeyDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        hostName: 'web-01',
        address: '10.0.0.5',
        port: 22,
        purpose: 'test',
        logger
      })
    );
    expect(capturedVerify).toBeDefined();
  });

  it('verify после close этого Соединения в ssh2 не передаётся', async () => {
    let capturedVerify: ((valid: boolean) => void) | undefined;
    mockRequestHostKeyDecision.mockImplementation(({ verify }) => {
      capturedVerify = verify;
    });
    const { connection, emit } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);

    const { connection: handle, outcome } = openConnection(
      target,
      { kind: 'password', password: 'pw' },
      { purpose: 'session' }
    );
    const connectConfig = vi.mocked(handle.connect).mock.calls[0]?.[0] as unknown as {
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => void;
    };
    const verifySpy = vi.fn();
    connectConfig.hostVerifier(Buffer.from('key'), verifySpy);
    expect(capturedVerify).toBeDefined();

    emit('close');
    await outcome;

    capturedVerify!(true);
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('пустой пароль не попадает в connect', () => {
    const { connection } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);

    const { connection: handle } = openConnection(target, { kind: 'password', password: '' }, { purpose: 'session' });
    const config = vi.mocked(handle.connect).mock.calls[0]?.[0] as Record<string, unknown>;

    expect(config['password']).toBeUndefined();
  });

  it('непустой пароль передаётся как есть', () => {
    const { connection } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);

    const { connection: handle } = openConnection(
      target,
      { kind: 'password', password: 'secret' },
      { purpose: 'session' }
    );
    const config = vi.mocked(handle.connect).mock.calls[0]?.[0] as Record<string, unknown>;

    expect(config['password']).toBe('secret');
  });

  it('ключ: privateKey всегда, passphrase только если непустой', () => {
    const { connection } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);

    const key = Buffer.from('fake-key');
    const { connection: handle } = openConnection(target, { kind: 'key', privateKey: key }, { purpose: 'session' });
    const config = vi.mocked(handle.connect).mock.calls[0]?.[0] as Record<string, unknown>;

    expect(config['privateKey']).toBe(key);
    expect(config['passphrase']).toBeUndefined();
  });

  it('ключ с passphrase — передаётся', () => {
    const { connection } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);

    const key = Buffer.from('fake-key');
    const { connection: handle } = openConnection(
      target,
      { kind: 'key', privateKey: key, passphrase: 'sesame' },
      { purpose: 'session' }
    );
    const config = vi.mocked(handle.connect).mock.calls[0]?.[0] as Record<string, unknown>;

    expect(config['passphrase']).toBe('sesame');
  });

  it('keyboard-interactive: пароль для password-метода', () => {
    const { connection, emit } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);
    const finish = vi.fn();

    openConnection(target, { kind: 'password', password: 'secret' }, { purpose: 'session' });
    emit(
      'keyboard-interactive',
      'name',
      'instructions',
      'en',
      [
        { prompt: 'Password:', echo: false },
        { prompt: 'Confirm:', echo: false }
      ],
      finish
    );

    expect(finish).toHaveBeenCalledWith(['secret', 'secret']);
  });

  it("keyboard-interactive: '' для ключевого метода", () => {
    const { connection, emit } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);
    const finish = vi.fn();

    openConnection(target, { kind: 'key', privateKey: Buffer.from('k') }, { purpose: 'session' });
    emit('keyboard-interactive', 'name', 'instructions', 'en', [{ prompt: 'Prompt:', echo: false }], finish);

    expect(finish).toHaveBeenCalledWith(['']);
  });

  it('sock подключается вместо собственного TCP', () => {
    const { connection } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);
    const sock = { fake: 'channel' } as unknown as import('ssh2').ClientChannel;

    const { connection: handle } = openConnection(target, { kind: 'password', password: 'pw' }, {
      purpose: 'session',
      sock
    });
    const config = vi.mocked(handle.connect).mock.calls[0]?.[0] as Record<string, unknown>;

    expect(config['sock']).toBe(sock);
  });

  it('readyTimeout считается по формуле connectTimeoutSec*1000 + HOSTKEY_DECISION_TIMEOUT_MS, keepalive задан', () => {
    const { connection } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);

    const { connection: handle } = openConnection(target, { kind: 'password', password: 'pw' }, {
      purpose: 'session'
    });
    const config = vi.mocked(handle.connect).mock.calls[0]?.[0] as Record<string, unknown>;

    expect(config['readyTimeout']).toBe(10 * 1000 + 300_000);
    expect(config['keepaliveInterval']).toBe(30 * 1000);
    expect(config['keepaliveCountMax']).toBe(3);
    expect(config['tryKeyboard']).toBe(true);
  });

  it('исключение из connect() → outcome socket', async () => {
    const { connection } = makeFakeConnection();
    vi.mocked(connection.connect).mockImplementation(() => {
      throw new Error('sync failure');
    });
    __setConnectionFactoryForTest(() => connection);

    const { outcome } = openConnection(target, { kind: 'password', password: 'pw' }, { purpose: 'session' });

    expect(await outcome).toEqual({ ok: false, reason: 'socket' });
  });

  it('onGreeting/onHandshake вызываются с аргументами ssh2', () => {
    const { connection, emit } = makeFakeConnection();
    __setConnectionFactoryForTest(() => connection);
    const onGreeting = vi.fn();
    const onHandshake = vi.fn();

    openConnection(target, { kind: 'password', password: 'pw' }, { purpose: 'session', onGreeting, onHandshake });

    emit('greeting', 'SSH-2.0-OpenSSH_9.6');
    expect(onGreeting).toHaveBeenCalledTimes(1);

    const negotiated = { kex: 'curve25519-sha256', cs: { cipher: 'aes256-gcm', mac: '' } };
    emit('handshake', negotiated);
    expect(onHandshake).toHaveBeenCalledWith(negotiated);
  });
});
