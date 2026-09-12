import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./knownHosts', () => ({
  addKnownKey: vi.fn(),
  findKnownKey: vi.fn(),
  keyTypeFromBlob: vi.fn(() => 'ssh-ed25519'),
  replaceKnownKey: vi.fn(),
  sha256Fingerprint: vi.fn((buf: Buffer) => `sha256:${buf.toString('base64')}`)
}));
vi.mock('../ipc/events', () => ({ emit: vi.fn() }));

import { IPC } from '@shared/ipc';
import { emit } from '../ipc/events';
import { addKnownKey, findKnownKey, replaceKnownKey } from './knownHosts';
import { applyHostKeyDecision, HOSTKEY_DECISION_TIMEOUT_MS, requestHostKeyDecision } from './hostKeyDecision';

const mockEmit = vi.mocked(emit);
const mockFindKnownKey = vi.mocked(findKnownKey);
const mockAddKnownKey = vi.mocked(addKnownKey);
const mockReplaceKnownKey = vi.mocked(replaceKnownKey);

const rawKey = Buffer.from('fake-key');

/** requestId отправленного промпта — единственный способ достучаться до
 *  внутренней pending-записи, карта модулю приватна (по образцу sessionManager). */
function lastRequestId(): string {
  const call = mockEmit.mock.calls.at(-1);
  if (!call || call[0] !== IPC.evHostKeyPrompt) throw new Error('evHostKeyPrompt не отправлен');
  const prompt = call[1] as { requestId: string };
  return prompt.requestId;
}

describe('hostKeyDecision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('совпавший ключ → verify(true), без промпта и без записи', () => {
    mockFindKnownKey.mockReturnValue({ keyBase64: rawKey.toString('base64') });
    const verify = vi.fn();

    requestHostKeyDecision({
      hostName: 'web-01',
      address: '10.0.0.5',
      port: 22,
      rawKey,
      verify,
      purpose: 'session'
    });

    expect(verify).toHaveBeenCalledWith(true);
    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockAddKnownKey).not.toHaveBeenCalled();
  });

  it('незнакомый ключ: промпт isChanged=false; accept → addKnownKey + verify(true)', () => {
    mockFindKnownKey.mockReturnValue(null);
    const verify = vi.fn();

    requestHostKeyDecision({
      hostName: 'web-01',
      address: '10.0.0.5',
      port: 22,
      rawKey,
      verify,
      purpose: 'session'
    });

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const prompt = mockEmit.mock.calls[0]?.[1] as { isChanged: boolean };
    expect(prompt.isChanged).toBe(false);
    expect(verify).not.toHaveBeenCalled();

    applyHostKeyDecision(lastRequestId(), 'accept');

    expect(mockAddKnownKey).toHaveBeenCalledWith('10.0.0.5', 22, 'ssh-ed25519', rawKey);
    expect(mockReplaceKnownKey).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledWith(true);
  });

  it('незнакомый ключ: reject → verify(false), записи нет', () => {
    mockFindKnownKey.mockReturnValue(null);
    const verify = vi.fn();

    requestHostKeyDecision({
      hostName: 'web-01',
      address: '10.0.0.5',
      port: 22,
      rawKey,
      verify,
      purpose: 'session'
    });

    applyHostKeyDecision(lastRequestId(), 'reject');

    expect(mockAddKnownKey).not.toHaveBeenCalled();
    expect(mockReplaceKnownKey).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledWith(false);
  });

  it('изменившийся ключ: промпт isChanged=true с previousFingerprint; accept → replaceKnownKey', () => {
    mockFindKnownKey.mockReturnValue({ keyBase64: Buffer.from('old-key').toString('base64') });
    const verify = vi.fn();

    requestHostKeyDecision({
      hostName: 'web-01',
      address: '10.0.0.5',
      port: 22,
      rawKey,
      verify,
      purpose: 'session'
    });

    const prompt = mockEmit.mock.calls[0]?.[1] as { isChanged: boolean; previousFingerprint?: string };
    expect(prompt.isChanged).toBe(true);
    expect(prompt.previousFingerprint).toBeDefined();

    applyHostKeyDecision(lastRequestId(), 'accept');

    expect(mockReplaceKnownKey).toHaveBeenCalledWith('10.0.0.5', 22, 'ssh-ed25519', rawKey);
    expect(mockAddKnownKey).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledWith(true);
  });

  it('изменившийся ключ: reject → verify(false), старая запись цела (replaceKnownKey не зовётся)', () => {
    mockFindKnownKey.mockReturnValue({ keyBase64: Buffer.from('old-key').toString('base64') });
    const verify = vi.fn();

    requestHostKeyDecision({
      hostName: 'web-01',
      address: '10.0.0.5',
      port: 22,
      rawKey,
      verify,
      purpose: 'session'
    });

    applyHostKeyDecision(lastRequestId(), 'reject');

    expect(mockReplaceKnownKey).not.toHaveBeenCalled();
    expect(mockAddKnownKey).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledWith(false);
  });

  it('таймаут решения → verify(false), записи нет', () => {
    vi.useFakeTimers();
    mockFindKnownKey.mockReturnValue(null);
    const verify = vi.fn();

    requestHostKeyDecision({
      hostName: 'web-01',
      address: '10.0.0.5',
      port: 22,
      rawKey,
      verify,
      purpose: 'session'
    });

    vi.advanceTimersByTime(HOSTKEY_DECISION_TIMEOUT_MS);

    expect(verify).toHaveBeenCalledWith(false);
    expect(mockAddKnownKey).not.toHaveBeenCalled();

    // Решение уже применено таймаутом — повторный apply не должен звать verify снова.
    verify.mockClear();
    applyHostKeyDecision(lastRequestId(), 'accept');
    expect(verify).not.toHaveBeenCalled();
  });

  it('неизвестный или просроченный requestId → no-op, не бросает', () => {
    expect(() => applyHostKeyDecision('does-not-exist', 'accept')).not.toThrow();
    expect(mockAddKnownKey).not.toHaveBeenCalled();
  });

  it('решение принимается без логгера (аналог пути без живой Сессии) — accept и запись работают как обычно', () => {
    mockFindKnownKey.mockReturnValue(null);
    const verify = vi.fn();

    // Без поля logger — как вызывает testConnection.ts (PR-2) и как ведёт себя
    // decision после того, как Сессия уже закрылась.
    requestHostKeyDecision({
      hostName: 'quick@10.0.0.9',
      address: '10.0.0.9',
      port: 22,
      rawKey,
      verify,
      purpose: 'test'
    });

    expect(() => applyHostKeyDecision(lastRequestId(), 'accept')).not.toThrow();
    expect(mockAddKnownKey).toHaveBeenCalledWith('10.0.0.9', 22, 'ssh-ed25519', rawKey);
    expect(verify).toHaveBeenCalledWith(true);
  });
});
