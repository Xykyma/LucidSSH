import { randomUUID } from 'node:crypto';
import type { ConnectionLogEntry, ConnectionPurpose, HostKeyPrompt } from '@shared/ssh';
import { IPC } from '@shared/ipc';
import { emit } from '../ipc/events';
import { addKnownKey, findKnownKeys, keyTypeFromBlob, replaceHostKeys, sha256Fingerprint } from './knownHosts';

/**
 * Доверие ключу хоста — одно решение на каждое Соединение (ADR-0016,
 * `.scratch/host-key-decision/spec.md`). Раньше это была внутренность
 * `sessionManager` (карта `pendingHostKeys`, `handleHostKey`, `confirmHostKey`);
 * вынесено в свой модуль, которым пользуется и `sessionManager.ts` (purpose
 * 'session'), и `testConnection.ts` (purpose 'test', оба хопа цепочки через
 * jump-хост) — не таща доступ к живым Сессиям: этот модуль ничего о них не
 * знает, его зависимости — только `knownHosts` и `emit`.
 *
 * Единственное, что раньше требовало живую Сессию — запись в лог соединения.
 * Здесь это необязательный логгер, переданный при запросе решения: сам факт
 * accept/reject от него не зависит (PR-1 §"Что переезжает вместе с машинкой").
 */

export const HOSTKEY_DECISION_TIMEOUT_MS = 5 * 60 * 1000;

/** Логгер этапа решения — вызывающая сторона уже знает, в чей лог и с каким
 *  `step` класть запись (sessionManager передаёт свой `log()` с привязанным
 *  `step`; `testConnection` не передаёт ничего — решение работает и без лога). */
export type HostKeyDecisionLogger = (
  level: ConnectionLogEntry['level'],
  messageKey: string,
  params?: Record<string, string | number>
) => void;

export interface RequestHostKeyDecisionParams {
  hostName: string;
  address: string;
  port: number;
  rawKey: Buffer;
  verify: (valid: boolean) => void;
  logger?: HostKeyDecisionLogger;
  /** Зачем спрашивается решение — прокидывается в промпт как есть, см.
   *  `HostKeyPrompt.purpose`. */
  purpose: ConnectionPurpose;
}

interface PendingDecision {
  address: string;
  port: number;
  keyType: string;
  rawKey: Buffer;
  isChanged: boolean;
  verify: (valid: boolean) => void;
  logger?: HostKeyDecisionLogger;
  timeout: NodeJS.Timeout;
}

const pending = new Map<string, PendingDecision>();

/**
 * Запросить решение по ключу, предъявленному сервером. Совпал с уже известным —
 * отвечает синхронно, без промпта и без записи. Иначе заводит запись в
 * `pending`, шлёт `evHostKeyPrompt` в renderer и ждёт `applyHostKeyDecision`
 * (accept/reject/таймаут). Возвращает `requestId` поднятого промпта — чтобы
 * умершее до ответа Соединение могло его снять (`cancelHostKeyDecision`);
 * совпавший ключ промпта не поднимает — `undefined`.
 */
export function requestHostKeyDecision(params: RequestHostKeyDecisionParams): string | undefined {
  const { hostName, address, port, rawKey, verify, logger, purpose } = params;
  const keyType = keyTypeFromBlob(rawKey);
  const fingerprint = sha256Fingerprint(rawKey);
  logger?.('info', 'clog.hostkeyReceived', { keyType, fingerprint });

  // Совпадение с любым доверенным ключом хоста — совпадение; ключ, не
  // совпавший ни с одним, — смена, какого бы типа он ни был (ADR-0019).
  const known = findKnownKeys(address, port);
  const presented = rawKey.toString('base64');

  if (known.some((k) => k.keyBase64 === presented)) {
    logger?.('info', 'clog.hostkeyKnown');
    verify(true);
    return undefined;
  }

  const isChanged = known.length > 0;
  const requestId = randomUUID();
  const timeout = setTimeout(() => {
    const p = pending.get(requestId);
    if (p) {
      pending.delete(requestId);
      p.logger?.('warn', 'clog.hostkeyTimeout');
      p.verify(false);
    }
  }, HOSTKEY_DECISION_TIMEOUT_MS);

  pending.set(requestId, {
    address,
    port,
    keyType,
    rawKey,
    isChanged,
    verify,
    logger,
    timeout
  });

  logger?.(isChanged ? 'warn' : 'info', isChanged ? 'clog.hostkeyChanged' : 'clog.hostkeyNew');

  const prompt: HostKeyPrompt = {
    requestId,
    hostName,
    address,
    port,
    fingerprintSha256: fingerprint,
    keyType,
    isChanged,
    previousKeys: known.map((k) => ({
      keyType: k.keyType,
      fingerprint: sha256Fingerprint(Buffer.from(k.keyBase64, 'base64'))
    })),
    purpose
  };
  emit(IPC.evHostKeyPrompt, prompt);
  return requestId;
}

/** Снять решение, чьё Соединение умерло до ответа (закрыли вкладку, обрыв
 *  сети, `readyTimeout`): без записи в known_hosts и без `verify` — спрашивать
 *  больше не о чем, renderer убирает промпт из очереди модалок
 *  (`.scratch/hostkey-prompt-queue/spec.md`). Уже отвеченный/неизвестный
 *  `requestId` — no-op, события нет. */
export function cancelHostKeyDecision(requestId: string): void {
  const p = pending.get(requestId);
  if (!p) return;
  pending.delete(requestId);
  clearTimeout(p.timeout);
  emit(IPC.evHostKeyPromptCancelled, requestId);
}

/** Применить решение пользователя (SSH-03/04). Неизвестный/просроченный
 *  `requestId` — no-op, не бросает (мог истечь таймаутом или уже быть применён). */
export function applyHostKeyDecision(requestId: string, decision: 'accept' | 'reject'): void {
  const p = pending.get(requestId);
  if (!p) return;
  pending.delete(requestId);
  clearTimeout(p.timeout);

  if (decision === 'accept') {
    if (p.isChanged) {
      replaceHostKeys(p.address, p.port, p.keyType, p.rawKey);
      p.logger?.('warn', 'clog.hostkeyReplaced');
    } else {
      addKnownKey(p.address, p.port, p.keyType, p.rawKey);
      p.logger?.('info', 'clog.hostkeyAccepted');
    }
    p.verify(true);
  } else {
    p.logger?.('warn', 'clog.hostkeyRejected');
    p.verify(false);
  }
}
