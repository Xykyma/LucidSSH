import { randomUUID } from 'node:crypto';
import type { ConnectionLogEntry, HostKeyPrompt } from '@shared/ssh';
import { IPC } from '@shared/ipc';
import { emit } from '../ipc/events';
import { addKnownKey, findKnownKey, keyTypeFromBlob, replaceKnownKey, sha256Fingerprint } from './knownHosts';

/**
 * Доверие ключу хоста — одно решение на каждое Соединение (ADR-0016,
 * `.scratch/host-key-decision/spec.md`). Раньше это была внутренность
 * `sessionManager` (карта `pendingHostKeys`, `handleHostKey`, `confirmHostKey`);
 * вынесено в свой модуль, чтобы им мог пользоваться и `testConnection.ts`
 * (PR-2), не таща доступ к живым Сессиям — этот модуль ничего о них не знает,
 * его зависимости — только `knownHosts` и `emit`.
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
  hostId: number;
  hostName: string;
  address: string;
  port: number;
  rawKey: Buffer;
  verify: (valid: boolean) => void;
  logger?: HostKeyDecisionLogger;
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
 * (accept/reject/таймаут).
 */
export function requestHostKeyDecision(params: RequestHostKeyDecisionParams): void {
  const { hostId, hostName, address, port, rawKey, verify, logger } = params;
  const keyType = keyTypeFromBlob(rawKey);
  const fingerprint = sha256Fingerprint(rawKey);
  logger?.('info', 'clog.hostkeyReceived', { keyType, fingerprint });

  const known = findKnownKey(address, port, keyType);

  if (known && known.keyBase64 === rawKey.toString('base64')) {
    logger?.('info', 'clog.hostkeyKnown');
    verify(true);
    return;
  }

  const isChanged = known !== null;
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
    hostId,
    hostName,
    address,
    port,
    fingerprintSha256: fingerprint,
    isChanged,
    previousFingerprint: known ? sha256Fingerprint(Buffer.from(known.keyBase64, 'base64')) : undefined
  };
  emit(IPC.evHostKeyPrompt, prompt);
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
      replaceKnownKey(p.address, p.port, p.keyType, p.rawKey);
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
