/**
 * Типы SSH-сессий и лога соединения (Data_Structures.md §7.1).
 * Секретов в этих структурах нет (SEC-01, CLOG-03).
 */

export type SessionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface SessionInfo {
  sessionId: string;
  hostId: number;
  hostName: string;
  status: SessionStatus;
  /** Текст выполняющейся сейчас команды (WIN-04) — null, если промпт вернулся. */
  busyCommand: string | null;
}

/** Зачем открывается Соединение (ADR-0016): 'session' — вкладка с Сессией,
 *  'test' — кнопка «Проверить соединение» в форме хоста. */
export type ConnectionPurpose = 'session' | 'test';

export interface HostKeyPrompt {
  requestId: string;
  hostName: string;
  address: string;
  port: number;
  fingerprintSha256: string;
  isChanged: boolean; // true → ключ изменился, соединение заблокировано (SSH-04)
  previousFingerprint?: string;
  /** Зачем подняли промпт — влияет только на подписи кнопок (модалка одна и та
   *  же для обоих поводов): 'session' — реальное подключение, 'test' — кнопка
   *  «Проверить соединение» (ADR-0016), где после accept подключение не
   *  продолжается, поэтому «…и подключиться» в кнопке было бы неправдой. */
  purpose: ConnectionPurpose;
}

/**
 * Запрос интерактивного ввода пароля/passphrase прямо в терминале (когда для
 * хоста не сохранён секрет) — аналог промпта в PuTTY/консольном ssh (SSH-06).
 */
export interface AuthPromptRequest {
  sessionId: string;
  requestId: string;
  prompts: { text: string; echo: boolean }[];
  /** Незалогиненная попытка перед этой — сервер отклонил предыдущий ответ. */
  retry: boolean;
}

/** Результат пробного подключения (кнопка «Проверить соединение»). */
export interface TestConnectionResult {
  ok: boolean;
  /** Ключ i18n причины при ok=false (без секретов). */
  errorKey?: string;
  /** 'jump' — ошибка произошла на bastion, до целевого хоста дело не дошло
   *  (SSH-05); отсутствует — ошибка на целевом хосте (в т.ч. без jump-хоста). */
  step?: 'jump';
}

/** Запись known_hosts для показа в Настройки → Безопасность (SET-04). Без сырого ключа. */
export interface KnownHostView {
  line: number;
  host: string;
  /** Имя сервера из менеджера хостов, если найден по адресу+порту (иначе — нет). */
  name?: string;
  keyType: string;
  fingerprint: string; // SHA256:...
}

/**
 * Код завершения похож на "shell завершил foreground-процесс сигналом"
 * (128 + номер сигнала — POSIX-конвенция, напр. 130 = SIGINT/Ctrl+C).
 * Такие коды — не ошибка команды, а намеренное прерывание пользователем.
 */
export function isSignalExitCode(exitCode: number | null): boolean {
  return exitCode !== null && exitCode > 128 && exitCode <= 165;
}

export interface ConnectionLogEntry {
  timestamp: string; // ISO 8601
  level: 'info' | 'warn' | 'error';
  /** Ключ i18n + параметры: текст собирается на стороне отображения. Без секретов (CLOG-03). */
  messageKey: string;
  params?: Record<string, string | number>;
  /** Этап подключения. 'jump' — весь первый хоп через bastion (SSH-05): и его
   *  собственные tcp/hostkey/auth-записи, и ошибки — так они отличимы от
   *  записей целевого хоста, идущих следом с обычными step. */
  step?: 'tcp' | 'handshake' | 'hostkey' | 'auth' | 'session' | 'jump';
}
