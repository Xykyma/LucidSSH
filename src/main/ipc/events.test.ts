import { beforeEach, describe, expect, it, vi } from 'vitest';

// Единственная зависимость emit — главное окно. `electron` модуль `emit` не
// импортирует вовсе, поэтому мок `electron` здесь не нужен.
vi.mock('../window/mainWindow', () => ({ getMainWindow: vi.fn(() => null) }));

import { IPC } from '@shared/ipc';
import { getMainWindow } from '../window/mainWindow';
import { emit } from './events';

const mockGetMainWindow = vi.mocked(getMainWindow);

/** Фальшивое главное окно — emit'у хватает isDestroyed() и webContents.send. */
function fakeWindow(destroyed = false): {
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
} {
  return { isDestroyed: () => destroyed, webContents: { send: vi.fn() } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('emit', () => {
  it('молчит, когда окна нет', () => {
    mockGetMainWindow.mockReturnValue(null);

    expect(() => emit(IPC.evHistoryRecorded)).not.toThrow();
  });

  it('молчит, когда окно уничтожено', () => {
    // Регрессия: три точки в mainWindow.ts слали через `mainWindow?.webContents.send`
    // без этой проверки, пока все остальные её делали (ADR-0011).
    const win = fakeWindow(true);
    mockGetMainWindow.mockReturnValue(win as never);

    emit(IPC.evTerminalData, 'session-1', 'hello');

    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('передаёт канал и аргументы без изменений', () => {
    const win = fakeWindow();
    mockGetMainWindow.mockReturnValue(win as never);

    emit(IPC.evTerminalData, 'session-1', 'hello');

    expect(win.webContents.send).toHaveBeenCalledExactlyOnceWith(
      IPC.evTerminalData,
      'session-1',
      'hello'
    );
  });

  it('передаёт событие без аргументов', () => {
    const win = fakeWindow();
    mockGetMainWindow.mockReturnValue(win as never);

    emit(IPC.evHistoryRecorded);

    expect(win.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC.evHistoryRecorded);
  });
});
