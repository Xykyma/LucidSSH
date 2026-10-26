import type { HostKeyPrompt } from '@shared/ssh';

/**
 * Очередь промптов отпечатка (`.scratch/hostkey-prompt-queue/spec.md`).
 * Раньше стор держал одно значение — второй промпт затирал первый, а
 * затёртое Соединение через 5 минут падало по таймауту решения, хотя
 * пользователя ни о чём не спросили. Модалка показывает голову очереди.
 *
 * Чистые функции без React — стор в `.tsx` в стенд vitest не собирается.
 */

export function enqueueHostKeyPrompt(queue: HostKeyPrompt[], prompt: HostKeyPrompt): HostKeyPrompt[] {
  return [...queue, prompt];
}

export function removeHostKeyPrompt(queue: HostKeyPrompt[], requestId: string): HostKeyPrompt[] {
  return queue.filter((p) => p.requestId !== requestId);
}
