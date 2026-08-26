import { randomUUID } from 'node:crypto';
import { Client, type ClientChannel } from 'ssh2';
import type { ConnectionLogEntry, HostKeyPrompt, SessionStatus } from '@shared/ssh';
import { IPC } from '@shared/ipc';
import type { Host } from '@shared/hosts';
import { getHost } from '../hosts/repository';
import { getSecretForConnection } from '../keychain';
import { loadConfig } from '../config/store';
import { emit } from '../ipc/events';
import { loadPrivateKey, PrivateKeyError } from './keys';
import {
  addKnownKey,
  findKnownKey,
  keyTypeFromBlob,
  replaceKnownKey,
  sha256Fingerprint
} from './knownHosts';
import { forwardOut } from './forwardOut';
import { ShellChannel } from './shellChannel';
import { startDashboard, stopDashboard } from './dashboard';
import { deployPendingKey, hasPendingDeployment } from './keygen';
import { t } from '../i18n';
import type { GuardStatus } from '@shared/history';
import { notifyDisconnect } from '../notifications/notifier';
import {
  checkShellUnavailable as reportShellUnavailable,
  handleCommandFinished as reportCommandFinished,
  recordCommand as reportCommand,
  type SessionIdentity
} from './commandReport';

/** Размер PTY, с которым shell открывается до первого реального resize от
 *  renderer (совпадает со старым дефолтом ManagedSession.cols/rows). */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * SSH-сессии (SSH-01…SSH-07, §9 Security_Guide).
 * Протокол подключения: renderer передаёт только hostId; main достаёт хост из
 * SQLite и секрет из Credential Manager; host key проверяется ДО аутентификации
 * (это гарантирует и протокол SSH, и hostVerifier ssh2); renderer получает
 * только sessionId и статусы. Секрет не кэшируется дольше подключения.
 *
 * Конвейер вывода одного shell-потока (breadcrumb, эхо setup-команды,
 * реинжект после su/sudo, детекция запроса пароля, PTY-resize, детектор
 * ошибок/история команд) вынесен в `ShellChannel` (`shellChannel.ts`) —
 * получает уже открытый поток и ничего не знает про `ManagedSession`
 * (issue 03, `.scratch/shell-channel-extraction/spec.md`, ADR-0009).
 * `openShell` ниже — вся его связь с Соединением: открыть поток, обработать
 * ошибку открытия, построить канал, запустить дашборд.
 */

interface ManagedSession {
  id: string;
  hostId: number;
  hostName: string;
  client: Client | null;
  /** Соединение с jump-хостом (SSH-05), если хост подключается через bastion —
   *  держим отдельно от `client`: через него идёт только forwardOut-канал, а
   *  закрывать/пересоздавать нужно оба хопа. У каждой сессии он свой, пула нет
   *  (ADR-0007). */
  jumpClient: Client | null;
  status: SessionStatus;
  log: ConnectionLogEntry[];
  userClosed: boolean;
  reconnectAttempts: number;
  connectStartedAt: number;
  /** Была ли сессия хоть раз подключена — чтобы уведомлять о потере, не о неудаче (NOTIF-01). */
  everConnected: boolean;
  /** Канал закрылся с распознанной ssh-connection-ошибкой (nologin и т.п.) —
   *  автопереподключение бессмысленно, см. client.on('close', ...). */
  shellUnavailable?: boolean;
  /** Имя пользователя для Quick Connect (HM-11, hostId=0 — нет строки в hosts,
   *  getHost(0) всегда null) — фоллбэк для recordCommand, где обычно берётся из host. */
  quickConnectUsername?: string;
  /** Конвейер вывода текущего shell-потока — новый экземпляр на каждое
   *  открытие канала (в т.ч. после переподключения/эскалации), старый
   *  выбрасывается; отдельного reset() нет, чистое состояние гарантирует
   *  конструктор ShellChannel. `null` до первого openShell и после закрытия
   *  потока (см. onClosed в openShell). */
  shellChannel: ShellChannel | null;
}

interface PendingHostKey {
  sessionId: string;
  /** Адрес/порт сервера, к которому относится этот ключ — берутся из `host`,
   *  переданного в handleHostKey, а не из getHost(session.hostId): для Quick
   *  Connect (HM-11) hostId=0 и getHost(0) всегда null (SSH-03/04-регресс,
   *  см. .scratch/quickconnect-hostkey-confirm-bug/spec.md). */
  address: string;
  port: number;
  verify: (valid: boolean) => void;
  keyType: string;
  rawKey: Buffer;
  isChanged: boolean;
  /** Этап лога для решения по этому ключу: 'jump' — отпечаток bastion,
   *  'hostkey' — целевого хоста (SSH-05, оба диалога идут подряд). */
  step: ConnectionLogEntry['step'];
  timeout: NodeJS.Timeout;
}

interface PendingAuthPrompt {
  sessionId: string;
  resolve: (answers: string[]) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

const sessions = new Map<string, ManagedSession>();
const pendingHostKeys = new Map<string, PendingHostKey>();
const pendingAuthPrompts = new Map<string, PendingAuthPrompt>();

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 2500;
const HOSTKEY_DECISION_TIMEOUT_MS = 5 * 60 * 1000;
const AUTH_PROMPT_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_PASSPHRASE_ATTEMPTS = 3;
const MAX_PASSWORD_ATTEMPTS = 3;

function setStatus(s: ManagedSession, status: SessionStatus): void {
  s.status = status;
  emit(IPC.evSessionStatus, s.id, status);
}

function log(
  s: ManagedSession,
  level: ConnectionLogEntry['level'],
  messageKey: string,
  params?: Record<string, string | number>,
  step?: ConnectionLogEntry['step']
): void {
  const entry: ConnectionLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    messageKey,
    params,
    step
  };
  s.log.push(entry);
  if (s.log.length > 500) s.log.shift();
  emit(IPC.evConnectionLog, s.id, entry);
}

/** Личность Сессии для commandReport.ts — см. SessionIdentity там: одной
 *  записью, а не по аргументу на поле. */
function identityOf(session: ManagedSession): SessionIdentity {
  return {
    id: session.id,
    hostId: session.hostId,
    hostName: session.hostName,
    quickConnectUsername: session.quickConnectUsername
  };
}

export function sessionExists(sessionId: string): boolean {
  return sessions.has(sessionId);
}

export function hostIdOf(sessionId: string): number | undefined {
  return sessions.get(sessionId)?.hostId;
}

export function getSessionLog(sessionId: string): ConnectionLogEntry[] {
  return sessions.get(sessionId)?.log ?? [];
}

export function listSessions(): Array<{
  sessionId: string;
  hostId: number;
  hostName: string;
  status: SessionStatus;
  busyCommand: string | null;
}> {
  return [...sessions.values()].map((s) => ({
    sessionId: s.id,
    hostId: s.hostId,
    hostName: s.hostName,
    status: s.status,
    busyCommand: s.shellChannel?.runningCommand() ?? null
  }));
}

/** Сессии, которые сейчас выполняют команду — хост+команда (WIN-04), для
 *  расширенного текста в диалоге закрытия окна (несколько вкладок сразу, где
 *  renderer заранее не имеет списка сессий — только count, см. mainWindow.ts). */
export function busySessions(): Array<{ hostName: string; command: string }> {
  return [...sessions.values()].flatMap((s) => {
    const command = s.shellChannel?.runningCommand() ?? null;
    return command === null ? [] : [{ hostName: s.hostName, command }];
  });
}

export async function connectHost(hostId: number): Promise<{ sessionId: string }> {
  const host = getHost(hostId);
  if (!host) throw new Error('host not found');

  const session: ManagedSession = {
    id: randomUUID(),
    hostId,
    hostName: host.name,
    client: null,
    jumpClient: null,
    status: 'connecting',
    log: [],
    userClosed: false,
    reconnectAttempts: 0,
    connectStartedAt: Date.now(),
    everConnected: false,
    shellChannel: null
  };
  sessions.set(session.id, session);
  setStatus(session, 'connecting');

  void establish(session, host);
  return { sessionId: session.id };
}

/**
 * Quick Connect (HM-11): подключение по `user@host[:port]` без записи в hosts.
 * `id: 0` — безопасный sentinel (SQLite AUTOINCREMENT начинается с 1, getHost(0)
 * всегда null), только пароль (без сохранённого секрета — establish() уже умеет
 * спрашивать пароль интерактивно, когда getSecretForConnection() ничего не находит).
 */
export async function connectQuickHost(
  address: string,
  port: number,
  username: string
): Promise<{ sessionId: string }> {
  const host: Host = {
    id: 0,
    name: `${username}@${address}`,
    address,
    port,
    username,
    authMethod: 'password',
    guardEnabled: true,
    historyEnabled: true,
    sortOrder: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const session: ManagedSession = {
    id: randomUUID(),
    hostId: 0,
    hostName: host.name,
    client: null,
    jumpClient: null,
    status: 'connecting',
    log: [],
    userClosed: false,
    reconnectAttempts: 0,
    connectStartedAt: Date.now(),
    everConnected: false,
    shellChannel: null,
    quickConnectUsername: username
  };
  sessions.set(session.id, session);
  setStatus(session, 'connecting');

  void establish(session, host);
  return { sessionId: session.id };
}

/**
 * Роль хоста в цепочке подключения (SSH-05). 'target' — обычный хост сессии:
 * после аутентификации открывается shell и дашборд. 'jump' — bastion: тот же
 * путь до 'ready' (свои креды, свой fingerprint-флоу), но дальше соединение
 * используется только как транспорт (forwardOut), поэтому ни shell, ни
 * дашборда, ни автопереподключения по нему нет — это делает целевой хоп.
 */
type ConnectRole = 'target' | 'jump';

interface AttemptOptions {
  role: ConnectRole;
  /** Открывает канал bastion→target, который ssh2 использует вместо
   *  собственного TCP-подключения (SSH-05). Именно фабрика, а не готовый
   *  канал: канал живёт ровно одну попытку входа и закрывается вместе с ней,
   *  поэтому повтору пароля (passwordLoginLoop) нужен свой. */
  openSock?: () => Promise<ClientChannel>;
}

const TARGET: AttemptOptions = { role: 'target' };

/** Шаг лога с учётом роли: весь первый хоп помечается 'jump', чтобы его
 *  записи не смешивались с одноимёнными записями целевого хоста. */
function stepFor(opts: AttemptOptions, step: ConnectionLogEntry['step']): ConnectionLogEntry['step'] {
  return opts.role === 'jump' ? 'jump' : step;
}

/**
 * Один заход на подключение: создаёт Client, вешает все обработчики, зовёт
 * connect(). Возвращает 'ready' при успехе (openShell уже вызван внутри —
 * кроме роли 'jump', где shell не нужен), 'auth-failed' — сервер отклонил
 * аутентификацию ДО открытия сессии и разрешён повторный запрос пароля
 * (allowAuthRetry), 'other' — прочие случаи (уже залогированы, и session
 * переведена в disconnected через finishDisconnected — вызывающему дальше
 * ничего делать не нужно).
 *
 * Тестовый рычаг (Часть 2 спеки): реальный `Client` создаётся через
 * подменяемую фабрику `clientFactory` — см. `__setClientFactoryForTest` и
 * `attemptConnectForTest` внизу файла.
 */
async function attemptConnect(
  session: ManagedSession,
  host: Host,
  password: string | undefined,
  privateKey: Buffer | undefined,
  keyPassphrase: string | undefined,
  allowAuthRetry: boolean,
  opts: AttemptOptions = TARGET
): Promise<'ready' | 'auth-failed' | 'other'> {
  const isJump = opts.role === 'jump';

  // Свой канал через bastion на каждую попытку (SSH-05): предыдущая унесла
  // свой с собой, когда её Client закрылся. Client целевого хоста ещё не
  // создаётся — если туннель не открылся, подключать нечего.
  let sock: ClientChannel | undefined;
  if (opts.openSock) {
    try {
      sock = await opts.openSock();
      log(session, 'info', 'clog.jump.tunnelOpen', undefined, 'jump');
    } catch {
      // Типичная причина — bastion запрещает проброс (AllowTcpForwarding no)
      // или целевой хост недоступен уже из его сети.
      log(session, 'error', 'clog.jump.tunnelFailed', undefined, 'jump');
      finishDisconnected(session);
      return 'other';
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: 'ready' | 'auth-failed' | 'other'): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const cfg = loadConfig();
    // Тестовый дублёр реализует только узкий FakeableClient — приводим к
    // Client один раз здесь, на границе seam'а (см. FakeableClient внизу
    // файла); дальше по функции и в openShell/dashboard.ts используется
    // обычный тип Client, ничего о подмене не зная.
    const client = clientFactory() as unknown as Client;
    if (isJump) session.jumpClient = client;
    else session.client = client;

    client.on('greeting', (greeting: string) => {
      // Баннер сервера — недоверенный текст; в лог кладём только факт
      void greeting;
      log(session, 'info', 'clog.greeting', undefined, stepFor(opts, 'tcp'));
    });

    client.on('handshake', (negotiated) => {
      log(
        session,
        'info',
        'clog.handshake',
        {
          kex: negotiated?.kex ?? '?',
          cipher: negotiated?.cs?.cipher ?? '?',
          mac: negotiated?.cs?.mac ?? '',
          ms: Date.now() - session.connectStartedAt
        },
        stepFor(opts, 'handshake')
      );
    });

    // Некоторые серверы не предлагают password auth, только keyboard-interactive
    // (виден как "Keyboard-interactive authentication prompts from server" в
    // PuTTY-логах). ssh2 не пробует его без tryKeyboard: true и обработчика —
    // отвечаем тем же паролем, что и в connectConfig, это не альтернатива
    // password auth, а его серверный вариант (SSH-06).
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      const answer = password ?? '';
      finish(prompts.map(() => answer));
    });

    client.on('ready', () => {
      session.reconnectAttempts = 0;
      log(
        session,
        'info',
        'clog.ready',
        {
          method: password !== undefined ? 'password' : host.authMethod,
          ms: Date.now() - session.connectStartedAt
        },
        stepFor(opts, 'auth')
      );
      // HM-12 шаг 4: успешный пароль-логин — момент автоматической дозаписи
      // ожидающего публичного ключа в authorized_keys (дедупликация внутри;
      // no-op, если для этого keyPath ничего не ждёт). Помимо тихой записи в
      // «Детали подключения», результат печатается прямо в терминал — в этот
      // момент пользователь и так смотрит именно туда (только что вводил
      // пароль), а лог подключения открывают редко.
      if (password !== undefined && host.keyPath) {
        void deployPendingKey(client, host.keyPath, (level, key) => {
          log(session, level, key, undefined, stepFor(opts, 'session'));
          emit(IPC.evTerminalData, session.id, `\r\n${t(key)}\r\n`);
        });
      }
      // Bastion — только транспорт: shell и дашборд открываются на целевом
      // хосте, а туннель через этот Client поднимает establishJumpTunnel.
      if (!isJump) openShell(session, client);
      settle('ready');
    });

    let authFailed = false;
    client.on('error', (err: Error & { level?: string }) => {
      const category =
        err.level === 'client-authentication'
          ? 'auth'
          : err.level === 'client-timeout'
            ? 'timeout'
            : 'socket';
      if (category === 'auth') authFailed = true;
      // Текст ошибки ssh2 не содержит секретов, но для надёжности не пробрасываем его.
      // Общий ключ для bastion и целевого хоста — различение по `step` (см.
      // wrapJumpStep в renderer), не по отдельному переводу.
      log(
        session,
        'error',
        `clog.error.${category}`,
        undefined,
        stepFor(opts, category === 'auth' ? 'auth' : 'tcp')
      );
    });

    client.on('close', () => {
      if (isJump) {
        // Bastion закрылся. До 'ready' — это провал всей попытки (ниже общая
        // ветка); после — целевой Client всё равно потеряет свой forwardOut-
        // канал и уйдёт в обычное автопереподключение (SSH-06), которое
        // поднимет оба хопа заново; отдельной логики здесь не нужно.
        if (settled) {
          session.jumpClient = null;
          return;
        }
      }
      if (settled) {
        // Сессия уже была открыта раньше — обычное последующее отключение,
        // штатная логика автопереподключения (не связана с retry паролем).
        if (session.userClosed || session.shellUnavailable) {
          finishDisconnected(session);
          return;
        }
        // HM-11: Quick Connect (hostId=0) не переподключается автоматически —
        // хост нигде не сохранён, getHost(0) всегда null, реконнектить нечем.
        if (session.hostId !== 0 && session.status === 'connected' && loadConfig().connection.autoreconnect) {
          scheduleReconnect(session);
          return;
        }
        if (session.hostId !== 0 && session.status === 'reconnecting') {
          scheduleReconnect(session);
          return;
        }
        finishDisconnected(session);
        return;
      }
      // Закрытие ДО 'ready' — эта попытка подключения провалилась.
      if (authFailed && allowAuthRetry) {
        settle('auth-failed');
        return;
      }
      finishDisconnected(session);
      settle('other');
    });

    const connectConfig: Parameters<Client['connect']>[0] = {
      host: host.address,
      port: host.port,
      username: host.username,
      // readyTimeout охватывает весь путь до 'ready', включая ожидание решения
      // пользователя по fingerprint в hostVerifier. Добавляем окно решения, иначе
      // долгое подтверждение отпечатка ложно роняет соединение по таймауту.
      // Недоступность сервера ловится раньше ОС-ошибками сокета (refused/unreachable).
      readyTimeout: cfg.connection.connectTimeoutSec * 1000 + HOSTKEY_DECISION_TIMEOUT_MS,
      keepaliveInterval: cfg.connection.keepaliveIntervalSec * 1000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        handleHostKey(session, host, key, verify, opts);
      }
    };

    // Подключение через jump-хост (SSH-05): вместо собственного TCP ssh2 берёт
    // открытый выше канал bastion→target. host/port остаются адресом целевого
    // сервера — они нужны для known_hosts и сообщений лога.
    if (sock) connectConfig.sock = sock;

    // Выбор по переданным кредам, а не по host.authMethod: для key-хоста с
    // ожидающим дозаписи ключом (HM-12) первый вход идёт по паролю.
    if (password !== undefined) {
      if (password) connectConfig.password = password;
    } else {
      connectConfig.privateKey = privateKey;
      if (keyPassphrase) connectConfig.passphrase = keyPassphrase;
    }

    // Секрет живёт только в локальной области видимости этой функции и в
    // конфиге ssh2 на время подключения — нигде не кэшируется (§9.9 гайда).
    try {
      client.connect(connectConfig);
    } catch {
      log(session, 'error', 'clog.error.socket', undefined, stepFor(opts, 'tcp'));
      finishDisconnected(session);
      settle('other');
    }
  });
}

/** Тестовый алиас без изменения сигнатуры (Часть 2 спеки, по образцу
 *  `parseMetricsForTest` в dashboard.ts) — тесты зовут машину состояний
 *  подключения напрямую, минуя establish()/hosts/repository.ts/keychain. */
export const attemptConnectForTest = attemptConnect;

/**
 * Полное подключение сессии к своему хосту, включая первый хоп через bastion,
 * если он задан (SSH-05). Вызывается и при первом подключении, и при
 * автопереподключении (SSH-06) — то есть обрыв поднимает оба хопа заново,
 * специального кода под jump-хост для этого не нужно.
 */
async function establish(session: ManagedSession, host: Host): Promise<void> {
  session.connectStartedAt = Date.now();
  // Переподключение (SSH-06) поднимает цепочку с нуля — соединение с bastion
  // от прошлой попытки закрываем здесь, иначе оно осталось бы висеть на
  // сервере без единой ссылки на себя.
  closeJumpClient(session, 'end');

  let bastion: JumpTunnel | null = null;
  if (host.proxyJumpHostId !== undefined) {
    bastion = await establishJumpTunnel(session, host, host.proxyJumpHostId);
    // Провал первого хопа уже залогирован и перевёл сессию в disconnected.
    if (!bastion) return;
  }

  if (bastion) {
    log(
      session,
      'info',
      'clog.tcpConnectingViaJump',
      { address: host.address, port: host.port, jump: bastion.name },
      'tcp'
    );
  } else {
    log(session, 'info', 'clog.tcpConnecting', { address: host.address, port: host.port }, 'tcp');
  }

  await connectWithCredentials(session, host, { role: 'target', openSock: bastion?.openSock });
}

interface JumpTunnel {
  name: string;
  /** Новый канал bastion→target поверх уже установленного первого хопа. */
  openSock: () => Promise<ClientChannel>;
}

/**
 * Первый хоп: соединение с bastion своими кредами и своим подтверждением
 * fingerprint (SSH-03/04 — диалоги идут строго последовательно, сначала
 * bastion, потом целевой хост). Возвращает способ открыть канал до целевого
 * сервера; null — цепочка оборвалась на bastion (причина в логе со
 * `step: 'jump'`, сессия уже переведена в disconnected).
 *
 * Соединение с bastion принадлежит этой сессии и никому больше: несколько
 * сессий через один и тот же bastion открывают его столько же раз (ADR-0007).
 */
async function establishJumpTunnel(
  session: ManagedSession,
  host: Host,
  jumpHostId: number
): Promise<JumpTunnel | null> {
  // Основная защита от self-reference и цепочек — repo.checkJumpHost
  // (ADR-0006), вызывается при сохранении хоста. Проверка здесь — запасная,
  // на случай прямой правки БД в обход приложения: без неё установление
  // соединения ушло бы в цикл вместо понятной ошибки.
  if (jumpHostId === host.id) {
    log(session, 'error', 'clog.jump.selfReference', undefined, 'jump');
    finishDisconnected(session);
    return null;
  }

  const bastion = getHost(jumpHostId);
  if (!bastion) {
    log(session, 'error', 'clog.jump.hostMissing', undefined, 'jump');
    finishDisconnected(session);
    return null;
  }

  log(
    session,
    'info',
    'clog.jump.connecting',
    { name: bastion.name, address: bastion.address, port: bastion.port },
    'jump'
  );

  // Второй прыжок не поддерживается (ADR-0006): собственный proxyJumpHostId
  // bastion-хоста здесь намеренно не читается.
  const connected = await connectWithCredentials(session, bastion, { role: 'jump' });
  if (!connected) return null; // причина уже в логе, сессия закрыта
  const client = session.jumpClient;
  if (!client) {
    // Bastion разорвал соединение сразу после аутентификации — туннель уже
    // не открыть (jumpClient обнуляется его обработчиком 'close').
    log(session, 'error', 'clog.jump.tunnelFailed', undefined, 'jump');
    finishDisconnected(session);
    return null;
  }

  return {
    name: bastion.name,
    openSock: () => forwardOut(client, host.address, host.port)
  };
}

/**
 * Достаёт креды хоста и доводит подключение до 'ready' (или до окончательной
 * неудачи): passphrase/пароль спрашиваются в терминале, если не сохранены.
 * Одинаково работает для целевого хоста и для bastion — разница только в
 * `opts` (роль, шаги и ключи лога, готовый sock). true — соединение
 * установлено.
 */
async function connectWithCredentials(
  session: ManagedSession,
  host: Host,
  opts: AttemptOptions
): Promise<boolean> {
  // Секрет достаётся из Credential Manager непосредственно перед подключением
  // и не сохраняется в объекте сессии (§9.9 гайда).
  let secret: string | null;
  try {
    secret = await getSecretForConnection(host.id);
  } catch {
    secret = null;
  }

  // Passphrase ключа: если не сохранён/неверен, запрашиваем интерактивно в
  // терминале (как PuTTY/консольный ssh), с ограниченным числом попыток —
  // ключ расшифровывается локально, до всякого обращения к серверу (SSH-06).
  let privateKey: Buffer | undefined;
  let keyPassphrase = secret ?? undefined;
  if (host.authMethod === 'key') {
    // HM-12 шаг 4: свежесгенерированный мастером ключ ещё не на сервере —
    // первый вход выполняется по паролю (интерактивный запрос в терминале);
    // на 'ready' ключ дозапишется в authorized_keys, и следующие подключения
    // пойдут уже по ключу. Если пользователь не ответил на запрос пароля,
    // пробуем обычный вход по ключу (вдруг ключ добавлен вручную).
    if (host.keyPath && hasPendingDeployment(host.keyPath)) {
      const result = await passwordLoginLoop(session, host, opts);
      if (result !== 'cancelled') return result === 'ready';
    }
    for (let attempt = 0; ; attempt++) {
      try {
        privateKey = loadPrivateKey(host.keyPath ?? '', keyPassphrase);
        break;
      } catch (err) {
        const reason = err instanceof PrivateKeyError ? err.reason : 'unparsable';
        if (reason !== 'needs-passphrase' || attempt >= MAX_PASSPHRASE_ATTEMPTS) {
          log(session, 'error', `clog.keyError.${reason}`, undefined, stepFor(opts, 'auth'));
          finishDisconnected(session);
          return false;
        }
        try {
          const promptKey = attempt === 0 ? 'sshAuth.passphrasePrompt' : 'sshAuth.passphrasePromptRetry';
          const [answer] = await requestAuthPrompt(
            session,
            [{ text: t(promptKey), echo: false }],
            attempt > 0
          );
          keyPassphrase = answer;
        } catch {
          log(session, 'error', 'clog.keyError.needs-passphrase', undefined, stepFor(opts, 'auth'));
          finishDisconnected(session);
          return false;
        }
      }
    }
    return (
      (await attemptConnect(session, host, undefined, privateKey, keyPassphrase, false, opts)) ===
      'ready'
    );
  }

  // Пароль не сохранён: спрашиваем ДО подключения (pre-flight, как и
  // passphrase выше) — это гарантирует connectConfig.password не пустым,
  // что нужно для серверов, не предлагающих keyboard-interactive (частый
  // случай на дефолтных настройках sshd, SSH-06).
  if (!secret) {
    const result = await passwordLoginLoop(session, host, opts);
    if (result === 'cancelled') {
      finishDisconnected(session);
      return false;
    }
    return result === 'ready';
  }

  return (
    (await attemptConnect(session, host, secret, privateKey, keyPassphrase, false, opts)) === 'ready'
  );
}

/**
 * Интерактивный вход по паролю (SSH-06): запрашивает пароль в терминале и
 * подключается, при отказе сервера пересоздаёт попытку с новым Client и
 * переспрашивает (до MAX_PASSWORD_ATTEMPTS). 'ready'/'failed' — попытки
 * завершены (успех или окончательная неудача уже обработаны внутри
 * attemptConnect), 'cancelled' — пользователь не ответил на запрос пароля;
 * что делать с сессией дальше, решает вызывающая сторона.
 */
async function passwordLoginLoop(
  session: ManagedSession,
  host: Host,
  opts: AttemptOptions
): Promise<'ready' | 'failed' | 'cancelled'> {
  for (let attempt = 0; ; attempt++) {
    let password: string;
    try {
      const promptKey = attempt === 0 ? 'sshAuth.passwordPrompt' : 'sshAuth.passwordPromptRetry';
      const [answer] = await requestAuthPrompt(
        session,
        [{ text: t(promptKey, { username: host.username, address: host.address }), echo: false }],
        attempt > 0
      );
      password = answer ?? '';
    } catch {
      return 'cancelled';
    }
    const allowRetry = attempt < MAX_PASSWORD_ATTEMPTS - 1;
    const result = await attemptConnect(
      session,
      host,
      password,
      undefined,
      undefined,
      allowRetry,
      opts
    );
    // 'ready'/'other' — уже обработано внутри attemptConnect
    if (result !== 'auth-failed') return result === 'ready' ? 'ready' : 'failed';
  }
}

function handleHostKey(
  session: ManagedSession,
  host: Host,
  rawKey: Buffer,
  verify: (valid: boolean) => void,
  opts: AttemptOptions = TARGET
): void {
  const keyType = keyTypeFromBlob(rawKey);
  const fingerprint = sha256Fingerprint(rawKey);
  const step = stepFor(opts, 'hostkey');
  log(session, 'info', 'clog.hostkeyReceived', { keyType, fingerprint }, step);

  const known = findKnownKey(host.address, host.port, keyType);

  if (known && known.keyBase64 === rawKey.toString('base64')) {
    log(session, 'info', 'clog.hostkeyKnown', undefined, step);
    verify(true);
    return;
  }

  const isChanged = known !== null;
  const requestId = randomUUID();
  const timeout = setTimeout(() => {
    const pending = pendingHostKeys.get(requestId);
    if (pending) {
      pendingHostKeys.delete(requestId);
      log(session, 'warn', 'clog.hostkeyTimeout', undefined, step);
      pending.verify(false);
    }
  }, HOSTKEY_DECISION_TIMEOUT_MS);

  pendingHostKeys.set(requestId, {
    sessionId: session.id,
    address: host.address,
    port: host.port,
    verify,
    keyType,
    rawKey,
    isChanged,
    step,
    timeout
  });

  log(session, isChanged ? 'warn' : 'info', isChanged ? 'clog.hostkeyChanged' : 'clog.hostkeyNew', undefined, step);

  const prompt: HostKeyPrompt = {
    requestId,
    hostId: host.id,
    hostName: host.name,
    address: host.address,
    port: host.port,
    fingerprintSha256: fingerprint,
    isChanged,
    previousFingerprint: known
      ? sha256Fingerprint(Buffer.from(known.keyBase64, 'base64'))
      : undefined
  };
  emit(IPC.evHostKeyPrompt, prompt);
}

/**
 * Открытие интерактивного shell-канала после успешной аутентификации (TERM-01).
 * Вывод сервера — недоверенные данные: пересылается в renderer как строка и
 * вставляется в xterm через write(), не innerHTML (TERM-07, §13 гайда).
 */
function openShell(session: ManagedSession, client: Client): void {
  client.shell({ term: 'xterm-256color', cols: DEFAULT_COLS, rows: DEFAULT_ROWS }, (err, stream) => {
    if (err) {
      log(session, 'error', 'clog.shellError', undefined, 'session');
      setStatus(session, 'connected'); // канал не открылся, но соединение есть
      return;
    }
    session.everConnected = true;
    const identity = identityOf(session);
    session.shellChannel = new ShellChannel({
      sessionId: session.id,
      stream,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      deps: {
        onCommandFinished: (event) => reportCommandFinished(identity, event),
        onUnmarkedOutput: (output) => reportShellUnavailable(identity, output),
        onShellUnavailable: () => {
          session.shellUnavailable = true;
        },
        onClosed: () => {
          session.shellChannel = null;
          stopDashboard(session.id);
        }
      }
    });
    setStatus(session, 'connected');
    log(session, 'info', 'clog.shellOpen', undefined, 'session');

    // Мини-дашборд: отдельный exec-канал, интервал 10 с (DASH-02).
    // Логгер — причина недоступности метрик попадает в «Детали подключения» (DASH-05).
    startDashboard(session.id, client, session.hostId, (messageKey, params) =>
      log(session, 'warn', messageKey, params, 'session')
    );
  });
}

/** Прямая запись в историю (заблокированная стражем команда, HIST-05). */
export function recordBlockedCommand(sessionId: string, command: string): void {
  const session = sessions.get(sessionId);
  if (session) reportCommand(identityOf(session), command, undefined, 'blocked');
}

/** Отправка ввода пользователя в сессию — сырая, без Стража; вызывающая
 *  сторона (guard/manager.ts или XtermView при «не на промпте») сама решает,
 *  когда это уместно (см. GUARD-02/04). */
export function sendInput(sessionId: string, data: string): void {
  sessions.get(sessionId)?.shellChannel?.sendInput(data);
}

/**
 * Отправка ОДОБРЕННОЙ стражем команды (submitCommand/confirmDangerousCommand,
 * GUARD-02). В отличие от sendInput, дополнительно вырезает из вывода сервера
 * эхо именно этой команды — терминал уже показал её локально во время набора
 * (буфер строки на промпте в XtermView), без подавления команда дублировалась
 * бы на экране (набор + отдельное эхо от pty). guardStatus — статус Стража
 * для этой команды (confirmed при подтверждении опасной, иначе не передаётся) —
 * единственный писатель lastCommand/pendingGuardStatus внутри ShellIntegrationSession
 * (User Story 6 спеки: одна запись вместо двух независимых полей, которые
 * могли разойтись).
 */
export function sendCommandLine(sessionId: string, command: string, guardStatus?: GuardStatus): void {
  sessions.get(sessionId)?.shellChannel?.sendCommandLine(command, guardStatus);
}

/** Изменение размера pty под размер xterm (TERM-xx) — гейтинг по cols
 *  (issue 11 / ADR-0005) живёт внутри ShellChannel.resize; до открытия
 *  канала (shellChannel === null) запрос молча теряется — PTY откроется на
 *  DEFAULT_COLS×DEFAULT_ROWS, следующий resize-эвент (например, от
 *  ResizeObserver в XtermView) досинхронизирует размер. */
export function resizeSession(sessionId: string, cols: number, rows: number): void {
  sessions.get(sessionId)?.shellChannel?.resize(cols, rows);
}

/** Решение пользователя по fingerprint (SSH-03/04). */
export function confirmHostKey(requestId: string, decision: 'accept' | 'reject'): void {
  const pending = pendingHostKeys.get(requestId);
  if (!pending) return; // просроченный/неизвестный requestId игнорируется
  pendingHostKeys.delete(requestId);
  clearTimeout(pending.timeout);

  const session = sessions.get(pending.sessionId);

  if (decision === 'accept' && session) {
    if (pending.isChanged) {
      replaceKnownKey(pending.address, pending.port, pending.keyType, pending.rawKey);
      log(session, 'warn', 'clog.hostkeyReplaced', undefined, pending.step);
    } else {
      addKnownKey(pending.address, pending.port, pending.keyType, pending.rawKey);
      log(session, 'info', 'clog.hostkeyAccepted', undefined, pending.step);
    }
    pending.verify(true);
  } else {
    if (session) log(session, 'warn', 'clog.hostkeyRejected', undefined, pending.step);
    pending.verify(false);
  }
}

/**
 * Запросить у renderer ввод пароля/passphrase прямо в терминале (SSH-06),
 * когда для хоста нет сохранённого секрета — как в PuTTY/консольном ssh.
 */
function requestAuthPrompt(
  session: ManagedSession,
  prompts: { text: string; echo: boolean }[],
  retry: boolean
): Promise<string[]> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingAuthPrompts.delete(requestId);
      reject(new Error('auth prompt timeout'));
    }, AUTH_PROMPT_TIMEOUT_MS);
    pendingAuthPrompts.set(requestId, { sessionId: session.id, resolve, reject, timeout });
    emit(IPC.evAuthPrompt, {
      sessionId: session.id,
      requestId,
      prompts,
      retry
    });
  });
}

/** Ответ renderer на запрос пароля/passphrase. */
export function answerAuthPrompt(requestId: string, answers: string[]): void {
  const pending = pendingAuthPrompts.get(requestId);
  if (!pending) return; // просроченный/неизвестный requestId игнорируется
  clearTimeout(pending.timeout);
  pendingAuthPrompts.delete(requestId);
  pending.resolve(answers);
}

/** Отменить незавершённые промпты сессии — при закрытии вкладки/отключении. */
function cancelAuthPrompts(sessionId: string): void {
  for (const [id, pending] of pendingAuthPrompts) {
    if (pending.sessionId !== sessionId) continue;
    clearTimeout(pending.timeout);
    pendingAuthPrompts.delete(id);
    pending.reject(new Error('session closed'));
  }
}

function scheduleReconnect(session: ManagedSession): void {
  session.reconnectAttempts += 1;
  if (session.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    log(session, 'error', 'clog.reconnectGiveUp', undefined, 'session');
    finishDisconnected(session);
    return;
  }
  setStatus(session, 'reconnecting');
  log(session, 'warn', 'clog.reconnecting', { attempt: session.reconnectAttempts }, 'session');
  setTimeout(() => {
    if (session.userClosed) {
      finishDisconnected(session);
      return;
    }
    const host = getHost(session.hostId);
    if (!host) {
      finishDisconnected(session);
      return;
    }
    void establish(session, host);
  }, RECONNECT_DELAY_MS);
}

function finishDisconnected(session: ManagedSession): void {
  log(session, 'info', 'clog.closed', undefined, 'session');
  setStatus(session, 'disconnected');
  stopDashboard(session.id);
  cancelAuthPrompts(session.id);
  session.client = null;
  // Второй хоп ушёл — соединение с bastion больше некому обслуживать
  // (переподключение поднимет его заново). Обнуляем поле ДО end(), чтобы
  // ответное 'close' от него ничего не пересоздавало.
  closeJumpClient(session, 'end');
  // NOTIF-01: уведомить о потере уже установленного соединения (не о неудаче входа
  // и не о закрытии пользователем).
  if (session.everConnected && !session.userClosed) {
    notifyDisconnect(session.hostName);
  }
}

/** Закрыть соединение с bastion, если оно есть (SSH-05). Поле обнуляется
 *  первым — обработчик 'close' на самом Client тогда просто ничего не делает. */
function closeJumpClient(session: ManagedSession, how: 'end' | 'destroy'): void {
  const client = session.jumpClient;
  if (!client) return;
  session.jumpClient = null;
  if (how === 'end') client.end();
  else client.destroy();
}

export function disconnectSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.userClosed = true;
  session.client?.end();
  if (!session.client) finishDisconnected(session);
}

/** Полное удаление сессии (закрытие вкладки). */
export function destroySession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.userClosed = true;
  session.shellChannel?.dispose();
  stopDashboard(sessionId);
  cancelAuthPrompts(sessionId);
  session.client?.destroy();
  closeJumpClient(session, 'destroy');
  sessions.delete(sessionId);
}

export function activeSessionCount(): number {
  return [...sessions.values()].filter(
    (s) => s.status === 'connected' || s.status === 'connecting' || s.status === 'reconnecting'
  ).length;
}

// ---------------------------------------------------------------------------
// Transport seam (Часть 2 спеки): фабрика Client подменяема на уровне модуля —
// тестам не нужен настоящий SSH-сервер, чтобы проверить attemptConnect (повтор
// пароля, keyboard-interactive, host-key verifier, отказ Quick Connect от
// автопереподключения). Публичные функции (connectHost, connectQuickHost,
// IPC-слой в ipc/sessions.ts) щели не видят — она приходит в игру только
// внутри attemptConnect. FakeableClient — узкий контракт: только то, чем
// реально пользуются sessionManager/dashboard.ts, не весь API ssh2.Client.
// ---------------------------------------------------------------------------

type ClientEventMap = {
  greeting: (greeting: string) => void;
  handshake: (negotiated: { kex?: string; cs?: { cipher?: string; mac?: string } }) => void;
  'keyboard-interactive': (
    name: string,
    instructions: string,
    lang: string,
    prompts: Array<{ prompt: string; echo: boolean }>,
    finish: (answers: string[]) => void
  ) => void;
  ready: () => void;
  error: (err: Error & { level?: string }) => void;
  close: () => void;
};

export interface FakeableClient {
  connect(config: Parameters<Client['connect']>[0]): void;
  on<E extends keyof ClientEventMap>(event: E, handler: ClientEventMap[E]): unknown;
  shell: Client['shell'];
  exec: Client['exec'];
  /** Туннель до целевого хоста, когда этот Client — bastion (SSH-05). */
  forwardOut: Client['forwardOut'];
  end(): void;
  destroy(): void;
}

let clientFactory: () => FakeableClient = () => new Client();

/** Тестовый рычаг (по образцу `parseMetricsForTest` в dashboard.ts): подменить
 *  фабрику Client фальшивым дублёром или сбросить к настоящему ssh2.Client. */
export function __setClientFactoryForTest(factory: (() => FakeableClient) | null): void {
  clientFactory = factory ?? (() => new Client());
}
