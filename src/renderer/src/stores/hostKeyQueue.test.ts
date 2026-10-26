import { describe, expect, it } from 'vitest';
import type { HostKeyPrompt } from '@shared/ssh';
import { enqueueHostKeyPrompt, removeHostKeyPrompt } from './hostKeyQueue';

/**
 * Очередь промптов отпечатка (`.scratch/hostkey-prompt-queue/spec.md`):
 * второй промпт больше не затирает первый — модалка показывает голову
 * очереди, следующий появляется после ответа на текущий.
 */

function prompt(requestId: string): HostKeyPrompt {
  return {
    requestId,
    hostName: `host-${requestId}`,
    address: '10.0.0.5',
    port: 22,
    fingerprintSha256: 'SHA256:abc',
    keyType: 'ssh-ed25519',
    isChanged: false,
    previousKeys: [],
    purpose: 'session'
  };
}

describe('очередь промптов отпечатка', () => {
  it('два промпта подряд — показан первый, ответ на него показывает второй, ответ на второй — пусто', () => {
    let queue = enqueueHostKeyPrompt([], prompt('a'));
    queue = enqueueHostKeyPrompt(queue, prompt('b'));
    expect(queue[0]?.requestId).toBe('a');

    queue = removeHostKeyPrompt(queue, 'a');
    expect(queue[0]?.requestId).toBe('b');

    queue = removeHostKeyPrompt(queue, 'b');
    expect(queue).toEqual([]);
  });

  it('снятие ждущего промпта (его Соединение умерло) не меняет показанный', () => {
    let queue = [prompt('a'), prompt('b'), prompt('c')];
    queue = removeHostKeyPrompt(queue, 'b');
    expect(queue.map((p) => p.requestId)).toEqual(['a', 'c']);
  });

  it('снятие неизвестного requestId — очередь не меняется', () => {
    const queue = [prompt('a')];
    expect(removeHostKeyPrompt(queue, 'gone')).toEqual(queue);
  });
});
