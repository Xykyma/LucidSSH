import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Настоящий known_hosts во временной папке: решение проверяется по тому, что
// реально лежит в файле, а не по вызовам мока `knownHosts` — иначе «тот же
// хост, ключ другого типа» в тесте не выразить (ADR-0019).
const dir = vi.hoisted(() => ({ path: '' }));
vi.mock('../config/store', () => ({ configDir: () => dir.path }));
vi.mock('../ipc/events', () => ({ emit: vi.fn() }));

import { IPC } from '@shared/ipc';
import type { HostKeyPrompt } from '@shared/ssh';
import { emit } from '../ipc/events';
import { sha256Fingerprint } from './knownHosts';
import {
  applyHostKeyDecision,
  cancelHostKeyDecision,
  HOSTKEY_DECISION_TIMEOUT_MS,
  requestHostKeyDecision
} from './hostKeyDecision';

const mockEmit = vi.mocked(emit);

/** Блоб host key в wire-формате: первое length-prefixed поле — тип ключа. */
function keyBlob(keyType: string, body: string): Buffer {
  const type = Buffer.from(keyType, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(type.length);
  return Buffer.concat([len, type, Buffer.from(body, 'utf8')]);
}

const ed25519 = keyBlob('ssh-ed25519', 'genuine');
const ecdsa = keyBlob('ecdsa-sha2-nistp256', 'genuine');
const rsa = keyBlob('ssh-rsa', 'genuine');

function knownHostsPath(): string {
  return join(dir.path, 'known_hosts');
}

function writeKnownHosts(lines: string[]): void {
  writeFileSync(knownHostsPath(), lines.join('\n') + '\n', 'utf8');
}

function line(host: string, keyType: string, blob: Buffer): string {
  return `${host} ${keyType} ${blob.toString('base64')}`;
}

function knownHostsLines(): string[] {
  if (!existsSync(knownHostsPath())) return [];
  return readFileSync(knownHostsPath(), 'utf8').split('\n').filter((l) => l !== '');
}

function lastPrompt(): HostKeyPrompt {
  const call = mockEmit.mock.calls.at(-1);
  if (!call || call[0] !== IPC.evHostKeyPrompt) throw new Error('evHostKeyPrompt не отправлен');
  return call[1] as HostKeyPrompt;
}

function request(rawKey: Buffer): ReturnType<typeof vi.fn> {
  const verify = vi.fn();
  requestHostKeyDecision({ hostName: 'web-01', address: '10.0.0.5', port: 22, rawKey, verify, purpose: 'session' });
  return verify;
}

describe('hostKeyDecision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dir.path = mkdtempSync(join(tmpdir(), 'lucidssh-hostkey-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir.path, { recursive: true, force: true });
  });

  it('совпавший ключ → verify(true), без промпта и без записи', () => {
    writeKnownHosts([line('10.0.0.5', 'ssh-ed25519', ed25519)]);

    const verify = request(ed25519);

    expect(verify).toHaveBeenCalledWith(true);
    expect(mockEmit).not.toHaveBeenCalled();
    expect(knownHostsLines()).toEqual([line('10.0.0.5', 'ssh-ed25519', ed25519)]);
  });

  it('незнакомый хост: промпт isChanged=false; accept → ключ записан, verify(true)', () => {
    const verify = request(ed25519);

    expect(lastPrompt().isChanged).toBe(false);
    expect(verify).not.toHaveBeenCalled();

    applyHostKeyDecision(lastPrompt().requestId, 'accept');

    expect(knownHostsLines()).toEqual([line('10.0.0.5', 'ssh-ed25519', ed25519)]);
    expect(verify).toHaveBeenCalledWith(true);
  });

  it('незнакомый хост: reject → verify(false), known_hosts не создан', () => {
    const verify = request(ed25519);

    applyHostKeyDecision(lastPrompt().requestId, 'reject');

    expect(knownHostsLines()).toEqual([]);
    expect(verify).toHaveBeenCalledWith(false);
  });

  it('изменившийся ключ того же типа: промпт isChanged=true с прежним; accept → заменён', () => {
    const forged = keyBlob('ssh-ed25519', 'forged');
    writeKnownHosts([line('10.0.0.5', 'ssh-ed25519', ed25519)]);

    const verify = request(forged);

    expect(lastPrompt().isChanged).toBe(true);

    applyHostKeyDecision(lastPrompt().requestId, 'accept');

    expect(knownHostsLines()).toEqual([line('10.0.0.5', 'ssh-ed25519', forged)]);
    expect(verify).toHaveBeenCalledWith(true);
  });

  it('изменившийся ключ: reject → verify(false), known_hosts не тронут', () => {
    writeKnownHosts([line('10.0.0.5', 'ssh-ed25519', ed25519)]);

    const verify = request(keyBlob('ssh-ed25519', 'forged'));
    applyHostKeyDecision(lastPrompt().requestId, 'reject');

    expect(knownHostsLines()).toEqual([line('10.0.0.5', 'ssh-ed25519', ed25519)]);
    expect(verify).toHaveBeenCalledWith(false);
  });

  it('таймаут решения → verify(false), known_hosts не тронут', () => {
    vi.useFakeTimers();
    writeKnownHosts([line('10.0.0.5', 'ssh-ed25519', ed25519)]);

    const verify = request(keyBlob('ssh-ed25519', 'forged'));
    vi.advanceTimersByTime(HOSTKEY_DECISION_TIMEOUT_MS);

    expect(verify).toHaveBeenCalledWith(false);
    expect(knownHostsLines()).toEqual([line('10.0.0.5', 'ssh-ed25519', ed25519)]);

    // Решение уже применено таймаутом — повторный apply не должен звать verify снова.
    verify.mockClear();
    applyHostKeyDecision(lastPrompt().requestId, 'accept');
    expect(verify).not.toHaveBeenCalled();
    expect(knownHostsLines()).toEqual([line('10.0.0.5', 'ssh-ed25519', ed25519)]);
  });

  it('известный хост, ключ другого типа → смена ключа (SSH-04), а не первое подключение', () => {
    writeKnownHosts([line('10.0.0.5', 'ssh-ed25519', ed25519)]);

    const verify = request(ecdsa);

    expect(verify).not.toHaveBeenCalled();
    const prompt = lastPrompt();
    expect(prompt.isChanged).toBe(true);
    expect(prompt.keyType).toBe('ecdsa-sha2-nistp256');
    expect(prompt.previousKeys).toEqual([{ keyType: 'ssh-ed25519', fingerprint: sha256Fingerprint(ed25519) }]);
  });

  it('accept смены ключа другого типа → у хоста ровно один ключ, чужие строки целы', () => {
    writeKnownHosts([
      line('10.0.0.5', 'ssh-ed25519', ed25519),
      line('10.0.0.7', 'ssh-ed25519', ed25519),
      line('[10.0.0.5]:2222', 'ssh-rsa', rsa),
      line('10.0.0.5', 'ssh-rsa', rsa)
    ]);

    const verify = request(ecdsa);
    applyHostKeyDecision(lastPrompt().requestId, 'accept');

    expect(knownHostsLines()).toEqual([
      line('10.0.0.7', 'ssh-ed25519', ed25519),
      line('[10.0.0.5]:2222', 'ssh-rsa', rsa),
      line('10.0.0.5', 'ecdsa-sha2-nistp256', ecdsa)
    ]);
    expect(verify).toHaveBeenCalledWith(true);
  });

  it('несколько доверенных ключей хоста: совпал любой → verify(true), без промпта и без записи', () => {
    const before = [line('10.0.0.5', 'ssh-ed25519', ed25519), line('10.0.0.5', 'ssh-rsa', rsa)];
    writeKnownHosts(before);

    const verify = request(rsa);

    expect(verify).toHaveBeenCalledWith(true);
    expect(mockEmit).not.toHaveBeenCalled();
    expect(knownHostsLines()).toEqual(before);
  });

  it('отмена (Соединение умерло до ответа) → verify не вызван, known_hosts не тронут, промпт снят в renderer', () => {
    vi.useFakeTimers();
    writeKnownHosts([line('10.0.0.5', 'ssh-ed25519', ed25519)]);

    const verify = request(keyBlob('ssh-ed25519', 'forged'));
    const { requestId } = lastPrompt();
    cancelHostKeyDecision(requestId);

    expect(mockEmit).toHaveBeenLastCalledWith(IPC.evHostKeyPromptCancelled, requestId);

    // Таймер снят, запоздалый ответ из оставшейся модалки — no-op.
    vi.advanceTimersByTime(HOSTKEY_DECISION_TIMEOUT_MS);
    applyHostKeyDecision(requestId, 'accept');

    expect(verify).not.toHaveBeenCalled();
    expect(knownHostsLines()).toEqual([line('10.0.0.5', 'ssh-ed25519', ed25519)]);
  });

  it('отмена уже отвеченного решения → no-op, повторного события в renderer нет', () => {
    const verify = request(ed25519);
    const { requestId } = lastPrompt();
    applyHostKeyDecision(requestId, 'accept');
    mockEmit.mockClear();

    cancelHostKeyDecision(requestId);

    expect(mockEmit).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('неизвестный или просроченный requestId → no-op, не бросает', () => {
    expect(() => applyHostKeyDecision('does-not-exist', 'accept')).not.toThrow();
    expect(knownHostsLines()).toEqual([]);
  });

  it('решение принимается без логгера (аналог пути без живой Сессии) — accept и запись работают как обычно', () => {
    const verify = vi.fn();

    // Без поля logger — как вызывает testConnection.ts (PR-2) и как ведёт себя
    // decision после того, как Сессия уже закрылась.
    requestHostKeyDecision({
      hostName: 'quick@10.0.0.9',
      address: '10.0.0.9',
      port: 22,
      rawKey: ed25519,
      verify,
      purpose: 'test'
    });

    expect(() => applyHostKeyDecision(lastPrompt().requestId, 'accept')).not.toThrow();
    expect(knownHostsLines()).toEqual([line('10.0.0.9', 'ssh-ed25519', ed25519)]);
    expect(verify).toHaveBeenCalledWith(true);
  });
});
