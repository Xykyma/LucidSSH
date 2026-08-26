import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@shared/config';
import type { Host } from '@shared/hosts';

// sessionManager.ts тянет за собой (транзитивно) better-sqlite3/keytar/Electron
// через hosts/repository, keychain, config/store, knownHosts, dashboard,
// content/loader, history/repository, notifications/notifier, window/mainWindow —
// ни один из них не нужен машине состояний attemptConnect (Часть 2 спеки,
// `.scratch/shell-integration-session/spec.md`: seam ограничен attemptConnect
// и фабрикой Client, establish()/hosts/keychain НЕ подменяются, а собираются
// тестом вручную — см. Testing Decisions). Мокаем по образцу guard/manager.test.ts.
vi.mock('../hosts/repository', () => ({ getHost: vi.fn() }));
vi.mock('../keychain', () => ({ getSecretForConnection: vi.fn() }));
vi.mock('../config/store', () => ({ loadConfig: vi.fn(), updateConfig: vi.fn() }));
vi.mock('../window/mainWindow', () => ({ getMainWindow: vi.fn(() => null) }));
vi.mock('./knownHosts', () => ({
  addKnownKey: vi.fn(),
  findKnownKey: vi.fn(() => null),
  keyTypeFromBlob: vi.fn(() => 'ssh-ed25519'),
  replaceKnownKey: vi.fn(),
  sha256Fingerprint: vi.fn(() => 'sha256:fake')
}));
vi.mock('./dashboard', () => ({ startDashboard: vi.fn(), stopDashboard: vi.fn() }));
vi.mock('../content/loader', () => ({
  loadErrorPatterns: vi.fn(() => []),
  loadCommandCatalog: vi.fn(() => ({ version: '1', categories: [], categoryLabels: {}, commands: [] }))
}));
vi.mock('../errors/detector', () => ({
  detectError: vi.fn(() => ({ matched: false, fallback: 'doc-search' })),
  isEmptyOutput: vi.fn(() => true)
}));
vi.mock('../i18n', () => ({ t: vi.fn((key: string) => key) }));
vi.mock('../history/repository', () => ({ recordHistory: vi.fn() }));
vi.mock('../notifications/notifier', () => ({ notifyDisconnect: vi.fn(), notifyCommandDone: vi.fn() }));

import { IPC } from '@shared/ipc';
import type { HostKeyPrompt, SessionStatus } from '@shared/ssh';
import { loadConfig } from '../config/store';
import { startDashboard } from './dashboard';
import { getMainWindow } from '../window/mainWindow';
import { getSecretForConnection } from '../keychain';
import { getHost } from '../hosts/repository';
import { addKnownKey } from './knownHosts';
import {
  answerAuthPrompt,
  attemptConnectForTest,
  connectHost,
  connectQuickHost,
  confirmHostKey,
  destroySession,
  getSessionLog,
  listSessions,
  __setClientFactoryForTest,
  type FakeableClient
} from './sessionManager';

const mockLoadConfig = vi.mocked(loadConfig);
const mockStartDashboard = vi.mocked(startDashboard);
const mockGetMainWindow = vi.mocked(getMainWindow);
const mockGetSecretForConnection = vi.mocked(getSecretForConnection);
const mockGetHost = vi.mocked(getHost);
const mockAddKnownKey = vi.mocked(addKnownKey);

const fakeConfig = (): AppConfig =>
  ({
    version: '0.0.0',
    language: 'ru',
    connection: { autoreconnect: true, keepaliveIntervalSec: 30, connectTimeoutSec: 10 },
    ui: { hints: { errorPanel: true } },
    // recordCommand (issue 11 / ADR-0005 тесты гоняют реальный command-finished
    // через htop-маркер) выходит рано при enabled: false — не нужно мокать
    // getHost/recordHistory сверх уже замоканного в файле.
    history: { enabled: false },
    // HM-12: deployPendingKey (keygen.ts) читает это через тот же мокнутый
    // loadConfig — без поля падает на .find() при 'ready' с паролем.
    pendingKeyDeployments: []
  }) as unknown as AppConfig;

const fakeHost = (overrides: Partial<Host> = {}): Host => ({
  id: 1,
  name: 'web-01',
  address: '10.0.0.5',
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

// ManagedSession не экспортирован (по дизайну, см. guard/manager.test.ts) —
// достаточно минимальной формы, которую реально трогает attemptConnect.
type Session = Parameters<typeof attemptConnectForTest>[0];

const fakeSession = (overrides: Partial<Session> = {}): Session =>
  ({
    id: 's1',
    hostId: 1,
    hostName: 'web-01',
    client: null,
    status: 'connecting',
    log: [],
    userClosed: false,
    reconnectAttempts: 0,
    connectStartedAt: Date.now(),
    everConnected: false,
    shellChannel: null,
    ...overrides
  }) as unknown as Session;

/** Фальшивый ClientChannel, достаточный, чтобы openShell() отработал без
 *  падения (данные потока в этих тестах не нужны — их разбор уже покрыт
 *  shellIntegrationSession.test.ts). */
function fakeStream(): unknown {
  return {
    on: vi.fn(),
    stderr: { on: vi.fn() },
    write: vi.fn(),
    setWindow: vi.fn()
  };
}

/** Фальшивый ssh2.Client: копит обработчики on(event, …) и позволяет тесту
 *  сымитировать события сервера напрямую, без сети (Часть 2 спеки). */
function makeFakeClient(): { client: FakeableClient; emit: (event: string, ...args: unknown[]) => void } {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  let tunnels = 0;
  const client = {
    connect: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return client;
    }),
    shell: vi.fn((_opts: unknown, cb: (err: Error | undefined, stream: unknown) => void) => {
      cb(undefined, fakeStream());
    }),
    exec: vi.fn(),
    // Роль bastion (SSH-05): по умолчанию туннель открывается успешно, каждый
    // раз новым каналом (по номеру видно, что попытка получила свой, а не
    // переиспользовала прежний) — тесты, которым нужен отказ, переопределяют.
    forwardOut: vi.fn(
      (
        _srcIP: string,
        _srcPort: number,
        _dstIP: string,
        _dstPort: number,
        cb: (err: Error | undefined, channel: unknown) => void
      ) => {
        cb(undefined, { tunnel: ++tunnels });
      }
    ),
    end: vi.fn(),
    destroy: vi.fn()
  } as unknown as FakeableClient;

  const emit = (event: string, ...args: unknown[]): void => {
    for (const handler of handlers.get(event) ?? []) handler(...args);
  };

  return { client, emit };
}

/**
 * Обязательное покрытие (CLAUDE.md §10 по духу правила — конвейер, питающий
 * Стража/детектор/breadcrumb, не должен меняться без тестов): машина
 * состояний attemptConnect без сети и без реального SSH-сервера.
 */
describe('attemptConnectForTest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(fakeConfig());
  });

  afterEach(() => {
    __setClientFactoryForTest(null);
  });

  it('успешное подключение: ready → openShell вызван, статус ready', async () => {
    const { client, emit } = makeFakeClient();
    __setClientFactoryForTest(() => client);
    const session = fakeSession();

    const promise = attemptConnectForTest(session, fakeHost(), 'pw', undefined, undefined, false);
    emit('ready');
    const result = await promise;

    expect(result).toBe('ready');
    expect(session.status).toBe('connected');
    expect(mockStartDashboard).toHaveBeenCalledTimes(1);
  });

  it('неверный пароль с разрешённым повтором — auth-failed', async () => {
    const { client, emit } = makeFakeClient();
    __setClientFactoryForTest(() => client);
    const session = fakeSession();

    const promise = attemptConnectForTest(session, fakeHost(), 'wrong', undefined, undefined, true);
    emit('error', Object.assign(new Error('auth'), { level: 'client-authentication' }));
    emit('close');
    const result = await promise;

    expect(result).toBe('auth-failed');
    expect(mockStartDashboard).not.toHaveBeenCalled();
  });

  it('keyboard-interactive: отвечает паролем на каждый prompt сервера (SSH-06)', async () => {
    const { client, emit } = makeFakeClient();
    __setClientFactoryForTest(() => client);
    const session = fakeSession();
    const finish = vi.fn();

    const promise = attemptConnectForTest(session, fakeHost(), 'secret', undefined, undefined, false);
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

    emit('ready');
    await promise;
  });

  it('Quick Connect (hostId=0) — close после ready не планирует автопереподключение', async () => {
    const { client, emit } = makeFakeClient();
    __setClientFactoryForTest(() => client);
    const session = fakeSession({ hostId: 0 });

    const promise = attemptConnectForTest(session, fakeHost({ id: 0 }), 'pw', undefined, undefined, false);
    emit('ready');
    await promise;
    expect(session.status).toBe('connected');

    emit('close');
    // hostId=0 нигде не сохранён (HM-11) — реконнектить нечем, сессия сразу
    // уходит в disconnected, а не в 'reconnecting'.
    expect(session.status).toBe('disconnected');
  });

  it('закрытие канала до ready без allowAuthRetry — статус other, сессия disconnected', async () => {
    const { client, emit } = makeFakeClient();
    __setClientFactoryForTest(() => client);
    const session = fakeSession();

    const promise = attemptConnectForTest(session, fakeHost(), 'pw', undefined, undefined, false);
    emit('close');
    const result = await promise;

    expect(result).toBe('other');
    expect(session.status).toBe('disconnected');
    expect(mockStartDashboard).not.toHaveBeenCalled();
  });
});

/**
 * Регресс на `.scratch/quickconnect-hostkey-confirm-bug/spec.md`: confirmHostKey
 * брал address/port через getHost(session.hostId), который для Quick Connect
 * (hostId=0, HM-11) всегда null — accept проваливался в reject-ветку. Тест гоняет
 * confirmHostKey через реальный pendingHostKeys/sessions, populate которых
 * возможен только публичным путём connectQuickHost (карты приватны модулю).
 */
describe('confirmHostKey — Quick Connect (hostId=0)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(fakeConfig());
    mockGetSecretForConnection.mockResolvedValue('pw');
  });

  afterEach(() => {
    __setClientFactoryForTest(null);
  });

  it('accept сохраняет ключ и подтверждает подключение, а не отклоняет его', async () => {
    const sentPrompts: HostKeyPrompt[] = [];
    mockGetMainWindow.mockReturnValue({
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((channel: string, payload: HostKeyPrompt) => {
          if (channel === IPC.evHostKeyPrompt) sentPrompts.push(payload);
        })
      }
    } as unknown as ReturnType<typeof getMainWindow>);

    const { client, emit } = makeFakeClient();
    __setClientFactoryForTest(() => client);

    const mockConnect = vi.mocked(client.connect);

    void connectQuickHost('10.0.0.9', 22, 'nikita');
    // establish() ждёт getSecretForConnection() (замокан resolved-промисом) до
    // вызова attemptConnect()/client.connect() — даём микротаскам догнать.
    await vi.waitFor(() => {
      if (mockConnect.mock.calls.length === 0) throw new Error('client.connect ещё не вызван');
    });

    // hostVerifier не событие on(), а прямое поле connectConfig — зовём его так,
    // как это сделал бы ssh2 при рукопожатии.
    const connectConfig = mockConnect.mock.calls[0]?.[0] as unknown as {
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => void;
    };
    const verifySpy = vi.fn();
    connectConfig.hostVerifier(Buffer.from('fake-key'), verifySpy);

    expect(sentPrompts).toHaveLength(1);
    const requestId = sentPrompts[0]?.requestId;
    if (!requestId) throw new Error('requestId отсутствует в отправленном prompt');

    confirmHostKey(requestId, 'accept');

    expect(verifySpy).toHaveBeenCalledWith(true);
    expect(mockAddKnownKey).toHaveBeenCalledWith('10.0.0.9', 22, expect.any(String), expect.any(Buffer));

    emit('ready');
  });
});

/**
 * Реальное подключение через jump-хост (SSH-05, `.scratch/jump-host-support`,
 * тикет 02). Проверяется внешнее поведение цепочки — порядок хопов, параметры
 * forwardOut, канал-транспорт у целевого Client и различимость ошибок по
 * этапам — через тот же seam `__setClientFactoryForTest`, что и остальные
 * сценарии attemptConnect; настоящих сокетов и SSH-сервера нет.
 */
describe('подключение через jump-хост (SSH-05)', () => {
  const target = fakeHost({ id: 1, name: 'prod-db', address: '10.0.0.5', port: 22, proxyJumpHostId: 2 });
  const bastion = fakeHost({ id: 2, name: 'bastion', address: '203.0.113.7', port: 2222 });

  type Fake = ReturnType<typeof makeFakeClient>;

  /** Фабрика выдаёт клиентов в порядке подключения: bastion, целевой хост,
   *  дальше — следующая попытка/переподключение той же пары. */
  function chainClients(count = 2): { hops: Fake[]; created: () => number } {
    const hops = Array.from({ length: count }, () => makeFakeClient());
    let index = 0;
    __setClientFactoryForTest(() => {
      const hop = hops[index++];
      if (!hop) throw new Error(`фабрика Client вызвана больше ${count} раз`);
      return hop.client;
    });
    return { hops, created: () => index };
  }

  const connectCalls = (hop: Fake): unknown[][] => vi.mocked(hop.client.connect).mock.calls;

  async function waitForConnect(hop: Fake, call = 0): Promise<Record<string, unknown>> {
    await vi.waitFor(() => {
      if (connectCalls(hop).length <= call) throw new Error('client.connect ещё не вызван');
    });
    return connectCalls(hop)[call]?.[0] as Record<string, unknown>;
  }

  const statusOf = (sessionId: string): SessionStatus | undefined =>
    listSessions().find((s) => s.sessionId === sessionId)?.status;

  async function waitForDisconnected(sessionId: string): Promise<void> {
    await vi.waitFor(() => {
      if (statusOf(sessionId) !== 'disconnected') throw new Error('сессия ещё не закрыта');
    });
  }

  const logOf = (sessionId: string): Array<{ messageKey: string; step?: string }> => getSessionLog(sessionId);

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(fakeConfig());
    mockGetSecretForConnection.mockResolvedValue('pw');
    mockGetHost.mockImplementation((id: number) => (id === 1 ? target : id === 2 ? bastion : null));
  });

  afterEach(() => {
    __setClientFactoryForTest(null);
  });

  it('bastion подключается первым, целевой хост — через forwardOut-канал', async () => {
    const { hops } = chainClients();
    const [jump, dest] = hops as [Fake, Fake];

    const { sessionId } = await connectHost(1);

    // Первый хоп идёт на адрес/порт bastion и без готового канала.
    const jumpConfig = await waitForConnect(jump);
    expect(jumpConfig['host']).toBe('203.0.113.7');
    expect(jumpConfig['port']).toBe(2222);
    expect(jumpConfig['sock']).toBeUndefined();
    expect(connectCalls(dest)).toHaveLength(0);

    jump.emit('ready');

    const destConfig = await waitForConnect(dest);
    // Туннель запрашивается до целевого адреса/порта, а его канал уходит в
    // ssh2 как sock — своего TCP-подключения целевой Client не делает.
    expect(jump.client.forwardOut).toHaveBeenCalledWith(
      '127.0.0.1',
      0,
      '10.0.0.5',
      22,
      expect.any(Function)
    );
    expect(destConfig['sock']).toEqual({ tunnel: 1 });
    expect(destConfig['host']).toBe('10.0.0.5');

    dest.emit('ready');
    expect(statusOf(sessionId)).toBe('connected');
    // Shell и дашборд открываются только на целевом хосте.
    expect(mockStartDashboard).toHaveBeenCalledTimes(1);
    expect(jump.client.shell).not.toHaveBeenCalled();

    const keys = logOf(sessionId).map((e) => e.messageKey);
    expect(keys).toContain('clog.jump.connecting');
    expect(keys).toContain('clog.jump.tunnelOpen');
    expect(keys).toContain('clog.tcpConnectingViaJump');
    expect(keys.indexOf('clog.jump.connecting')).toBeLessThan(keys.indexOf('clog.tcpConnectingViaJump'));
  });

  it('ошибка на bastion логируется с step jump, до целевого хоста дело не доходит', async () => {
    const { hops, created } = chainClients();
    const [jump] = hops as [Fake, Fake];

    const { sessionId } = await connectHost(1);
    await waitForConnect(jump);

    jump.emit('error', Object.assign(new Error('auth'), { level: 'client-authentication' }));
    jump.emit('close');

    await waitForDisconnected(sessionId);
    // Общий ключ с целевым хостом (упрощение после code-review) —
    // различение по step, не по отдельному переводу.
    const entry = logOf(sessionId).find((e) => e.messageKey === 'clog.error.auth');
    expect(entry?.step).toBe('jump');
    expect(created()).toBe(1); // второй Client даже не создавался
  });

  it('после успешного bastion ошибка на целевом хосте логируется прежним step, тем же ключом', async () => {
    const { hops } = chainClients();
    const [jump, dest] = hops as [Fake, Fake];

    const { sessionId } = await connectHost(1);
    await waitForConnect(jump);
    jump.emit('ready');
    await waitForConnect(dest);

    dest.emit('error', Object.assign(new Error('auth'), { level: 'client-authentication' }));
    dest.emit('close');

    await waitForDisconnected(sessionId);
    // Тот же messageKey, что и при ошибке на bastion (тест выше) — единственное
    // отличие в записи лога это step, wrapJumpStep в renderer добавляет
    // префикс «Jump-хост · » только по нему.
    const entries = logOf(sessionId).filter((e) => e.messageKey === 'clog.error.auth');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.step).toBe('auth');
  });

  it('bastion, отказавший в туннеле, закрывает попытку с отдельной ошибкой', async () => {
    const { hops, created } = chainClients();
    const [jump] = hops as [Fake, Fake];
    vi.mocked(jump.client.forwardOut).mockImplementation(
      ((
        _srcIP: string,
        _srcPort: number,
        _dstIP: string,
        _dstPort: number,
        cb: (err: Error | undefined, channel: unknown) => void
      ) => {
        cb(new Error('administratively prohibited'), undefined);
        return jump.client;
      }) as unknown as typeof jump.client.forwardOut
    );

    const { sessionId } = await connectHost(1);
    await waitForConnect(jump);
    jump.emit('ready');

    await waitForDisconnected(sessionId);
    expect(logOf(sessionId).find((e) => e.messageKey === 'clog.jump.tunnelFailed')?.step).toBe('jump');
    expect(created()).toBe(1);
  });

  it('обрыв целевого хопа переподключает оба и закрывает прежний bastion (SSH-06)', async () => {
    vi.useFakeTimers();
    try {
      const { hops } = chainClients(4);
      const [jump1, dest1, jump2] = hops as [Fake, Fake, Fake, Fake];

      const { sessionId } = await connectHost(1);
      await waitForConnect(jump1);
      jump1.emit('ready');
      await waitForConnect(dest1);
      dest1.emit('ready');
      expect(statusOf(sessionId)).toBe('connected');

      dest1.emit('close'); // сервер разорвал соединение
      expect(statusOf(sessionId)).toBe('reconnecting');

      await vi.advanceTimersByTimeAsync(3000);
      // Переподключение поднимает первый хоп заново — новым соединением, а
      // прежнее закрывает: иначе на bastion копились бы висящие сессии.
      await waitForConnect(jump2);
      expect(jump1.client.end).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('повтор пароля на целевом хосте берёт новый канал через bastion, а не отработавший', async () => {
    // Пароль целевого хоста не сохранён — вход идёт через запрос в терминале
    // (SSH-06), и первая попытка «промахивается».
    mockGetSecretForConnection.mockImplementation(async (id: number) => (id === 2 ? 'pw' : null));
    const prompts: Array<{ requestId: string }> = [];
    mockGetMainWindow.mockReturnValue({
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((channel: string, payload: { requestId: string }) => {
          if (channel === IPC.evAuthPrompt) prompts.push(payload);
        })
      }
    } as unknown as ReturnType<typeof getMainWindow>);

    const { hops } = chainClients(3);
    const [jump, dest1, dest2] = hops as [Fake, Fake, Fake];

    await connectHost(1);
    await waitForConnect(jump);
    jump.emit('ready');

    await vi.waitFor(() => {
      if (prompts.length === 0) throw new Error('пароль ещё не запрошен');
    });
    answerAuthPrompt(prompts[0]!.requestId, ['wrong']);

    const firstConfig = await waitForConnect(dest1);
    expect(firstConfig['sock']).toEqual({ tunnel: 1 });
    dest1.emit('error', Object.assign(new Error('auth'), { level: 'client-authentication' }));
    dest1.emit('close');

    await vi.waitFor(() => {
      if (prompts.length < 2) throw new Error('пароль ещё не запрошен повторно');
    });
    answerAuthPrompt(prompts[1]!.requestId, ['right']);

    // Канал первой попытки закрылся вместе с её Client — вторая обязана
    // получить свой, иначе подключалась бы через мёртвый поток.
    const secondConfig = await waitForConnect(dest2);
    expect(secondConfig['sock']).toEqual({ tunnel: 2 });
    expect(jump.client.forwardOut).toHaveBeenCalledTimes(2);
  });

  it('закрытие вкладки закрывает и соединение с bastion (ADR-0007: пула нет)', async () => {
    const { hops } = chainClients();
    const [jump, dest] = hops as [Fake, Fake];

    const { sessionId } = await connectHost(1);
    await waitForConnect(jump);
    jump.emit('ready');
    await waitForConnect(dest);
    dest.emit('ready');

    destroySession(sessionId);
    expect(dest.client.destroy).toHaveBeenCalledTimes(1);
    expect(jump.client.destroy).toHaveBeenCalledTimes(1);
  });

  it('хост, указанный jump-хостом сам для себя, не подключается', async () => {
    const { created } = chainClients();
    mockGetHost.mockImplementation((id: number) =>
      id === 1 ? fakeHost({ id: 1, name: 'loop', proxyJumpHostId: 1 }) : null
    );

    const { sessionId } = await connectHost(1);
    await waitForDisconnected(sessionId);
    expect(logOf(sessionId).find((e) => e.messageKey === 'clog.jump.selfReference')?.step).toBe('jump');
    expect(created()).toBe(0);
  });

  it('удалённый из списка jump-хост даёт понятную ошибку, а не молчаливое прямое подключение', async () => {
    const { created } = chainClients();
    mockGetHost.mockImplementation((id: number) => (id === 1 ? target : null));

    const { sessionId } = await connectHost(1);
    await waitForDisconnected(sessionId);
    expect(logOf(sessionId).find((e) => e.messageKey === 'clog.jump.hostMissing')?.step).toBe('jump');
    expect(created()).toBe(0);
  });
});

