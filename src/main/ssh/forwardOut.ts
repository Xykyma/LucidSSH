import type { ClientChannel } from 'ssh2';
import type { Connection } from './connection';

/**
 * Канал bastion→target через уже установленное соединение с bastion (SSH-05).
 * Адрес источника ssh2 передаёт серверу лишь как справочный (в OpenSSH это
 * локальный конец форварда) — реального сокета за ним нет.
 *
 * Общая для `sessionManager.ts` (реальные сессии) и `testConnection.ts`
 * (кнопка «Проверить подключение») — раньше была продублирована в обоих
 * файлах дословно. `Pick<Connection, 'forwardOut'>` — узкий тип шва
 * (`connection.ts`, решение 9 спеки PR-2) — чтобы принимать и настоящее
 * Соединение, и фейковые из `fakeConnection.ts` без приведения типов.
 */
export function forwardOut(
  client: Pick<Connection, 'forwardOut'>,
  address: string,
  port: number
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, address, port, (err, channel) => {
      if (err || !channel) reject(err ?? new Error('forwardOut: no channel'));
      else resolve(channel);
    });
  });
}
