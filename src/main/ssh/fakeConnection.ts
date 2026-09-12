import { vi } from 'vitest';
import type { Connection } from './connection';

/**
 * Общий тестовый фейк `Connection` (PR-2 `.scratch/open-connection/spec.md`,
 * ADR-0017) — копит обработчики `on(event, …)` и позволяет тестам сымитировать
 * события ssh2 напрямую, без сети и без реального сервера. Заменяет прежние
 * `FakeableClient` (sessionManager.ts) и `FakeableTestClient` (testConnection.ts) —
 * оба типизировали одно и то же знание («как выглядит открытое Соединение»)
 * разной шириной по числу реально используемых членов, не по дефекту.
 *
 * Первый общий тестовый вспомогательный файл в репозитории: не `*.test.ts`,
 * попадает в `tsconfig.node.json` и под ESLint, но в продакшен-сборку не
 * попадает — импортируют только тесты (см. решения PR-2).
 */

export interface FakeConnectionOptions {
  /** Bastion отказывает в проверке (AllowTcpForwarding no и т.п.) — тесту
   *  testConnection.ts нужен отказной forwardOut, не только успешный. */
  forwardOutFails?: boolean;
}

export interface FakeConnection {
  connection: Connection;
  /** Сымитировать событие сервера — как это сделал бы настоящий ssh2.Client. */
  emit: (event: string, ...args: unknown[]) => void;
}

/** Фальшивый ClientChannel, достаточный, чтобы shell() отработал без падения
 *  (данные потока в этих тестах не нужны — их разбор покрыт shellIntegrationSession.test.ts). */
function fakeStream(): unknown {
  return {
    on: vi.fn(),
    stderr: { on: vi.fn() },
    write: vi.fn(),
    setWindow: vi.fn()
  };
}

export function makeFakeConnection(opts: FakeConnectionOptions = {}): FakeConnection {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  // Счётчик туннелей (был только в фейке sessionManager.test.ts) — по номеру
  // видно, что попытка получила свой канал через bastion, а не переиспользовала
  // прежний (SSH-05, повтор пароля берёт новый канал).
  let tunnels = 0;

  const connection = {
    connect: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return connection;
    }),
    shell: vi.fn((_opts: unknown, cb: (err: Error | undefined, stream: unknown) => void) => {
      cb(undefined, fakeStream());
    }),
    exec: vi.fn(),
    forwardOut: vi.fn(
      (
        _srcIP: string,
        _srcPort: number,
        _dstIP: string,
        _dstPort: number,
        cb: (err: Error | undefined, channel: unknown) => void
      ) => {
        if (opts.forwardOutFails) cb(new Error('forward denied'), undefined);
        else cb(undefined, { tunnel: ++tunnels });
      }
    ),
    end: vi.fn(),
    destroy: vi.fn()
  } as unknown as Connection;

  const emit = (event: string, ...args: unknown[]): void => {
    for (const handler of handlers.get(event) ?? []) handler(...args);
  };

  return { connection, emit };
}
