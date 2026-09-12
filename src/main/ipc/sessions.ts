import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc';
import type { ConnectionLogEntry, SessionStatus, TestConnectionResult } from '@shared/ssh';
import { parseQuickConnect } from '@shared/quickConnect';
import {
  answerAuthPrompt,
  connectHost,
  connectQuickHost,
  destroySession,
  disconnectSession,
  getSessionLog,
  listSessions,
  resizeSession,
  sessionExists
} from '../ssh/sessionManager';
import { applyHostKeyDecision } from '../ssh/hostKeyDecision';
import {
  cancelDangerousCommand,
  confirmDangerousCommand,
  submitCommand,
  submitRawInput
} from '../guard/manager';
import type { SubmitResult } from '@shared/guard';
import { validateHostInput, validateId, validateSecret } from '../hosts/validate';
import { testConnection } from '../ssh/testConnection';
import { getSecretForConnection } from '../keychain';
import { assertSenderIsMainWindow, assertString, IpcValidationError } from './validate';

/**
 * IPC сессий (SSH-01…07, CLOG-01…03). Renderer оперирует только sessionId;
 * секреты и объекты соединений не пересекают границу процесса (SEC-05).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Только формат — без проверки, что сессия ещё жива (для fire-and-forget каналов ниже). */
function assertSessionIdFormat(v: unknown): string {
  return assertString(v, 'sessionId', 36, UUID_RE);
}

function validateSessionId(v: unknown): string {
  const id = assertSessionIdFormat(v);
  if (!sessionExists(id)) throw new IpcValidationError('sessionId: unknown');
  return id;
}

export function registerSessionIpcHandlers(): void {
  ipcMain.handle(IPC.sessionConnect, (event, rawHostId: unknown): Promise<{ sessionId: string }> => {
    assertSenderIsMainWindow(event);
    const hostId = validateId(rawHostId, 'hostId');
    return connectHost(hostId);
  });

  ipcMain.handle(IPC.sessionConnectQuick, (event, rawInput: unknown): Promise<{ sessionId: string }> => {
    assertSenderIsMainWindow(event);
    const input = assertString(rawInput, 'quickConnect', 320);
    const parsed = parseQuickConnect(input);
    if (!parsed) throw new IpcValidationError('quickConnect: invalid format');
    return connectQuickHost(parsed.address, parsed.port, parsed.username);
  });

  ipcMain.handle(IPC.sessionDisconnect, (event, rawSessionId: unknown): void => {
    assertSenderIsMainWindow(event);
    disconnectSession(validateSessionId(rawSessionId));
  });

  ipcMain.handle(IPC.sessionDestroy, (event, rawSessionId: unknown): void => {
    assertSenderIsMainWindow(event);
    destroySession(validateSessionId(rawSessionId));
  });

  ipcMain.handle(
    IPC.sessionList,
    (
      event
    ): Array<{
      sessionId: string;
      hostId: number;
      hostName: string;
      status: SessionStatus;
      busyCommand: string | null;
    }> => {
      assertSenderIsMainWindow(event);
      return listSessions();
    }
  );

  ipcMain.handle(IPC.sessionGetLog, (event, rawSessionId: unknown): ConnectionLogEntry[] => {
    assertSenderIsMainWindow(event);
    return getSessionLog(validateSessionId(rawSessionId));
  });

  // Сырой ввод в терминал — по большей части пока сессия НЕ на промпте (внутри
  // интерактивной программы, vim/htop): renderer сам решает это в XtermView, но
  // граница IPC не полагается на то, что renderer всегда угадает правильно —
  // submitRawInput сама прогоняет достаточно длинные куски через Стража
  // (.scratch/raw-input-guard-check/spec.md, GUARD-02/04). Ограничение длины —
  // защита от гигантских payload'ов. «Сессии уже нет» (закрыли вкладку, а
  // вызов уже летел) — тихий { status: 'sent' } из submitRawInput, не ошибка;
  // формат/тип входа проверяем строго, как и раньше.
  ipcMain.handle(
    IPC.sessionSendInput,
    (event, rawSessionId: unknown, rawData: unknown): SubmitResult => {
      assertSenderIsMainWindow(event);
      const id = assertSessionIdFormat(rawSessionId);
      if (typeof rawData !== 'string' || rawData.length > 100_000) {
        throw new IpcValidationError('data: invalid');
      }
      return submitRawInput(id, rawData);
    }
  );

  ipcMain.on(
    IPC.sessionResize,
    (event, rawSessionId: unknown, rawCols: unknown, rawRows: unknown): void => {
      assertSenderIsMainWindow(event);
      const id = assertSessionIdFormat(rawSessionId);
      const cols = Number(rawCols);
      const rows = Number(rawRows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || cols > 1000 || rows < 1 || rows > 1000) {
        throw new IpcValidationError('size: invalid');
      }
      if (!sessionExists(id)) return;
      resizeSession(id, cols, rows);
    }
  );

  // Пробное подключение из формы (кнопка «Проверить соединение»): проверяет
  // достижимость + аутентификацию, сессию не создаёт (§9.9). При редактировании
  // без нового секрета берём сохранённый из keychain.
  ipcMain.handle(
    IPC.sessionTestConnection,
    async (
      event,
      rawInput: unknown,
      rawSecret: unknown,
      rawHostId: unknown
    ): Promise<TestConnectionResult> => {
      assertSenderIsMainWindow(event);
      const input = validateHostInput(rawInput);
      let secret = validateSecret(rawSecret);
      const hostId =
        rawHostId !== undefined && rawHostId !== null ? validateId(rawHostId, 'hostId') : undefined;
      if (secret === undefined && hostId !== undefined) {
        try {
          secret = (await getSecretForConnection(hostId)) ?? undefined;
        } catch {
          secret = undefined;
        }
      }
      return testConnection(input, secret, hostId);
    }
  );

  ipcMain.handle(
    IPC.hostKeyConfirm,
    (event, rawRequestId: unknown, rawDecision: unknown): void => {
      assertSenderIsMainWindow(event);
      const requestId = assertString(rawRequestId, 'requestId', 36, UUID_RE);
      if (rawDecision !== 'accept' && rawDecision !== 'reject') {
        throw new IpcValidationError('decision: accept|reject expected');
      }
      applyHostKeyDecision(requestId, rawDecision);
    }
  );

  // Ответ пользователя на промпт пароля/passphrase, введённый прямо в
  // терминале (SSH-06). Ограничение длины — как у пароля хоста (validateSecret).
  ipcMain.handle(
    IPC.authPromptAnswer,
    (event, rawRequestId: unknown, rawAnswers: unknown): void => {
      assertSenderIsMainWindow(event);
      const requestId = assertString(rawRequestId, 'requestId', 36, UUID_RE);
      if (
        !Array.isArray(rawAnswers) ||
        rawAnswers.length > 10 ||
        rawAnswers.some((a) => typeof a !== 'string' || a.length > 1024)
      ) {
        throw new IpcValidationError('answers: invalid');
      }
      answerAuthPrompt(requestId, rawAnswers as string[]);
    }
  );

  // --- Страж (GUARD-02…04): команда проходит проверку в main до отправки ---
  ipcMain.handle(IPC.guardSubmit, (event, rawSessionId: unknown, rawCommand: unknown): SubmitResult => {
    assertSenderIsMainWindow(event);
    const sessionId = validateSessionId(rawSessionId);
    if (typeof rawCommand !== 'string' || rawCommand.length > 10_000) {
      throw new IpcValidationError('command: invalid');
    }
    return submitCommand(sessionId, rawCommand);
  });

  ipcMain.handle(
    IPC.guardConfirm,
    (event, rawRequestId: unknown, rawText: unknown): { allowed: boolean } => {
      assertSenderIsMainWindow(event);
      const requestId = assertString(rawRequestId, 'requestId', 36, UUID_RE);
      if (typeof rawText !== 'string' || rawText.length > 300) {
        throw new IpcValidationError('confirmationText: invalid');
      }
      return { allowed: confirmDangerousCommand(requestId, rawText) };
    }
  );

  ipcMain.on(IPC.guardCancel, (event, rawRequestId: unknown): void => {
    assertSenderIsMainWindow(event);
    const requestId = assertString(rawRequestId, 'requestId', 36, UUID_RE);
    cancelDangerousCommand(requestId);
  });
}
