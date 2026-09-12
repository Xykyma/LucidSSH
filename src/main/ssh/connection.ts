import { Client, type ClientChannel } from 'ssh2';
import { loadConfig } from '../config/store';
import { requestHostKeyDecision, HOSTKEY_DECISION_TIMEOUT_MS, type HostKeyDecisionLogger } from './hostKeyDecision';

/**
 * Одно Соединение до `ready` включительно (ADR-0017, `.scratch/open-connection/spec.md`).
 * Владеет фабрикой `ssh2.Client` и знанием о том, как открыть Соединение:
 * базовый конфиг, перевод `err.level`, проводка `hostVerifier` в
 * `hostKeyDecision.ts`, ответ на keyboard-interactive. Всё, что законно
 * разное у вызывающих — выбор метода входа, чтение приватного ключа, всё
 * после `ready` (shell, дашборд, автопереподключение, повтор пароля) —
 * остаётся у них; граница ADR-0009 не сдвигается.
 *
 * Узкий тип `Connection` — единственный на весь `src/main/ssh` (решение 9
 * спеки). Потребители объявляют только используемое: `openShell` в
 * `sessionManager.ts` — `Pick<Connection, 'shell'>`, `dashboard.ts`/`keygen.ts` —
 * `Pick<Connection, 'exec'>`, `forwardOut.ts` — `Pick<Connection, 'forwardOut'>`.
 * Приведение типа к настоящему `ssh2.Client` — только здесь, в фабрике по
 * умолчанию; общий тестовый фейк — `fakeConnection.ts`.
 */

export type ConnectionEventMap = {
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

export type ConnectConfig = Parameters<Client['connect']>[0];

/** Узкий тип шва — единственный на весь src/main/ssh. */
export interface Connection {
  connect(config: ConnectConfig): void;
  on<E extends keyof ConnectionEventMap>(event: E, handler: ConnectionEventMap[E]): unknown;
  shell: Client['shell'];
  exec: Client['exec'];
  /** Туннель до целевого хоста, когда это Соединение — bastion (SSH-05). */
  forwardOut: Client['forwardOut'];
  end(): void;
  destroy(): void;
}

export interface ConnectionTarget {
  name: string;
  address: string;
  port: number;
  username: string;
}

export type ConnectionCredentials =
  | { kind: 'password'; password: string }
  | { kind: 'key'; privateKey: Buffer; passphrase?: string };

export interface OpenConnectionOptions {
  /** Как есть в requestHostKeyDecision — прокидывается в промпт (см. HostKeyPrompt.purpose). */
  purpose: 'session' | 'test';
  /** Как есть в requestHostKeyDecision — необязательный, решение по ключу работает и без лога. */
  logger?: HostKeyDecisionLogger;
  /** Канал через bastion (SSH-05) — используется вместо собственного TCP ssh2. */
  sock?: ClientChannel;
  onGreeting?: () => void;
  onHandshake?: (negotiated: { kex?: string; cs?: { cipher?: string; mac?: string } }) => void;
}

export type ConnectionFailure = 'auth' | 'timeout' | 'socket' | 'hostkey-rejected';
export type ConnectionOutcome = { ok: true } | { ok: false; reason: ConnectionFailure };

/** Перевод `err.level` ssh2 в причину — используется и здесь, и вызывающими
 *  для ошибок ПОСЛЕ `ready` (решение 10 спеки), чтобы категоризация не
 *  раздвоилась снова, как до PR-1. */
export function classifyConnectionError(err: Error & { level?: string }): 'auth' | 'timeout' | 'socket' {
  return err.level === 'client-authentication' ? 'auth' : err.level === 'client-timeout' ? 'timeout' : 'socket';
}

/**
 * Открыть одно Соединение через ssh2. Ручка отдаётся синхронно, до `ready` —
 * это то, на чём держится отмена подключения (`end()`/`destroy()` →
 * `close` → провал `outcome`). `outcome` разрешается `{ ok: true }` на
 * `ready`; провал — только на `close` (к этому моменту Соединение
 * гарантированно мертво).
 *
 * Решение по ключу переживает своё Соединение: `hostVerifier` всегда
 * уходит в `requestHostKeyDecision`, но `verify`, дошедший ПОСЛЕ `close`
 * этого Соединения, в ssh2 не передаётся — known_hosts решение при этом
 * не трогает (пишет независимо от Client, см. `hostKeyDecision.ts`).
 */
export function openConnection(
  target: ConnectionTarget,
  credentials: ConnectionCredentials,
  options: OpenConnectionOptions
): { connection: Connection; outcome: Promise<ConnectionOutcome> } {
  const cfg = loadConfig();
  const connection = connectionFactory();

  let settled = false;
  let hostkeyRejected = false;
  let connectionClosed = false;
  let sawAuthError = false;
  let firstErrorCategory: 'auth' | 'timeout' | 'socket' | undefined;

  const outcome = new Promise<ConnectionOutcome>((resolve) => {
    const settle = (o: ConnectionOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(o);
    };

    connection.on('greeting', () => {
      options.onGreeting?.();
    });

    connection.on('handshake', (negotiated) => {
      options.onHandshake?.(negotiated);
    });

    // Некоторые серверы не предлагают password auth, только keyboard-interactive
    // (виден как "Keyboard-interactive authentication prompts from server" в
    // PuTTY-логах) — отвечаем тем же паролем, что и в connectConfig, это не
    // альтернатива password auth, а его серверный вариант (SSH-06).
    connection.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      const answer = credentials.kind === 'password' ? credentials.password : '';
      finish(prompts.map(() => answer));
    });

    connection.on('ready', () => {
      settle({ ok: true });
    });

    connection.on('error', (err) => {
      if (hostkeyRejected) return;
      const category = classifyConnectionError(err);
      if (category === 'auth') sawAuthError = true;
      firstErrorCategory ??= category;
    });

    connection.on('close', () => {
      connectionClosed = true;
      // Приоритет причины провала (решение 8 спеки): отказ по ключу — самая
      // информативная причина, даже если ssh2 следом сообщил обычную ошибку
      // соединения (level 'handshake', неотличимую от сетевой); дальше — была
      // ли хоть одна ошибка аутентификации; иначе категория первой ошибки;
      // закрылось без единой ошибки — socket.
      const reason: ConnectionFailure = hostkeyRejected
        ? 'hostkey-rejected'
        : sawAuthError
          ? 'auth'
          : (firstErrorCategory ?? 'socket');
      settle({ ok: false, reason });
    });

    const connectConfig: ConnectConfig = {
      host: target.address,
      port: target.port,
      username: target.username,
      // readyTimeout охватывает весь путь до 'ready', включая ожидание решения
      // пользователя по fingerprint в hostVerifier — иначе долгое подтверждение
      // отпечатка ложно роняет соединение по таймауту.
      readyTimeout: cfg.connection.connectTimeoutSec * 1000 + HOSTKEY_DECISION_TIMEOUT_MS,
      keepaliveInterval: cfg.connection.keepaliveIntervalSec * 1000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        requestHostKeyDecision({
          hostName: target.name,
          address: target.address,
          port: target.port,
          rawKey: key,
          purpose: options.purpose,
          logger: options.logger,
          verify: (valid) => {
            if (!valid) hostkeyRejected = true;
            // Соединение уже закрыто — запоздалое решение пользователя
            // (закрытие вкладки во время промпта, затем «Принять» в оставшейся
            // модалке) до ssh2 доводить незачем: known_hosts обновляется
            // независимо от Соединения, а отправка пароля в мёртвый сокет — нет.
            if (connectionClosed) return;
            verify(valid);
          }
        });
      }
    };

    if (options.sock) connectConfig.sock = options.sock;

    // Пустой пароль не передаётся в connectConfig.password (ADR-0017,
    // расхождение 3 спеки PR-1) — иначе ssh2 реально отправляет попытку входа
    // с пустым паролем, лишнюю запись в MaxAuthTries/fail2ban на сервере.
    if (credentials.kind === 'password') {
      if (credentials.password) connectConfig.password = credentials.password;
    } else {
      connectConfig.privateKey = credentials.privateKey;
      if (credentials.passphrase) connectConfig.passphrase = credentials.passphrase;
    }

    try {
      connection.connect(connectConfig);
    } catch {
      settle({ ok: false, reason: 'socket' });
    }
  });

  return { connection, outcome };
}

// ---------------------------------------------------------------------------
// Transport seam — единственный на src/main/ssh (по образцу прежних
// __setClientFactoryForTest в sessionManager.ts/testConnection.ts, теперь
// общий). Приведение типа к Client — единственное место на весь модуль.
// ---------------------------------------------------------------------------

let connectionFactory: () => Connection = () => new Client() as unknown as Connection;

/** Тестовый рычаг: подменить фабрику Соединения фальшивым дублёром
 *  (`fakeConnection.ts`) или сбросить к настоящему `ssh2.Client`. */
export function __setConnectionFactoryForTest(factory: (() => Connection) | null): void {
  connectionFactory = factory ?? (() => new Client() as unknown as Connection);
}
