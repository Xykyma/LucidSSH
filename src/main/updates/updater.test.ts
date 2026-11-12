import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/ipc';

/**
 * Manual-only обновления (NFR-05, тикет 07): portable exe никогда не вызывает
 * electron-updater. Проверка, скачивание и установка — no-op для любой
 * manual-only сборки даже при прямом вызове зарегистрированных IPC-каналов;
 * запрещённая установка не делает pre-update резервную копию и не перезапускает
 * приложение. Установленная Windows (NSIS) сохраняет прежний путь. Стенд —
 * реальные updater и регистрация IPC-хендлеров; мокаются только electron,
 * electron-updater, config store, события и бэкапы (тот же приём, что
 * ipc/boundary.test.ts). Тот же приём стаббинга process.platform и env, что
 * config/profileDir.test.ts.
 */

const ENV = 'PORTABLE_EXECUTABLE_DIR';

const stand = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  packaged: false
}));

const updaterMock = vi.hoisted(() => ({
  autoUpdater: {
    checkForUpdates: vi.fn(async () => ({})),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    on: vi.fn()
  }
}));

vi.mock('electron-updater', () => ({ default: { autoUpdater: updaterMock.autoUpdater } }));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.3-test',
    get isPackaged() {
      return stand.packaged;
    }
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown): void => {
      if (stand.handlers.has(channel)) throw new Error(`Duplicate ipcMain registration for channel "${channel}"`);
      stand.handlers.set(channel, fn);
    }
  }
}));

vi.mock('../config/store', () => ({
  loadConfig: vi.fn(() => ({ updates: { autoCheck: true, source: '' } }))
}));

vi.mock('../history/backups', () => ({ writePreUpdateBackup: vi.fn() }));
vi.mock('../ipc/events', () => ({ emit: vi.fn() }));

const mainWebContents = { send: vi.fn() };
vi.mock('../window/mainWindow', () => ({
  getMainWindow: vi.fn(() => ({ webContents: mainWebContents }))
}));

import electronUpdater from 'electron-updater';
import { getMainWindow } from '../window/mainWindow';
import { writePreUpdateBackup } from '../history/backups';
import { checkForUpdates, getStatus, initUpdater } from './updater';
import { registerUpdateIpcHandlers } from '../ipc/updates';

const { autoUpdater } = electronUpdater;

registerUpdateIpcHandlers();

const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')!;

function mainEvent(): IpcMainInvokeEvent {
  return { sender: mainWebContents } as unknown as IpcMainInvokeEvent;
}

async function invoke(channel: string): Promise<unknown> {
  const handler = stand.handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for channel "${channel}"`);
  return handler(mainEvent());
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  stand.packaged = false;
  delete process.env[ENV];
  Object.defineProperty(process, 'platform', platformDesc);
});

describe('portable Windows — manual-only', () => {
  beforeEach(() => {
    stand.packaged = true;
    process.env[ENV] = 'D:\\usb';
    Object.defineProperty(process, 'platform', { value: 'win32' }); // portable-режим существует только на Windows, а CI гоняет тесты и на Linux
    initUpdater();
  });

  it('статус: manualOnly с причиной portable', () => {
    expect(getStatus()).toMatchObject({ manualOnly: true, manualReason: 'portable' });
  });

  it('ручная и автоматическая проверка через IPC/direct не зовут autoUpdater', async () => {
    await invoke(IPC.updateCheck);
    await checkForUpdates(false); // автопроверка при запуске (main/index.ts)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('скачивание и установка через IPC — no-op: без скачивания, бэкапа и перезапуска', async () => {
    await invoke(IPC.updateDownload);
    await invoke(IPC.updateInstall);
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(writePreUpdateBackup).not.toHaveBeenCalled();
  });
});

describe('linux .deb — manual-only', () => {
  beforeEach(() => {
    stand.packaged = true;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    initUpdater();
  });

  it('статус: manualOnly с причиной deb; операции через IPC — no-op', async () => {
    expect(getStatus()).toMatchObject({ manualOnly: true, manualReason: 'deb' });
    await invoke(IPC.updateCheck);
    await invoke(IPC.updateDownload);
    await invoke(IPC.updateInstall);
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(writePreUpdateBackup).not.toHaveBeenCalled();
  });
});

describe('установленная Windows (NSIS) — прежний путь автообновления', () => {
  beforeEach(() => {
    stand.packaged = true; // переменной portable нет — установленная сборка
    Object.defineProperty(process, 'platform', { value: 'win32' });
    initUpdater();
  });

  it('статус: не manual-only; проверка, скачивание, бэкап и установка работают', async () => {
    expect(getStatus()).toMatchObject({ manualOnly: false, manualReason: undefined });

    await invoke(IPC.updateCheck);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalled();

    await invoke(IPC.updateDownload);
    expect(autoUpdater.downloadUpdate).toHaveBeenCalled();

    await invoke(IPC.updateInstall);
    expect(writePreUpdateBackup).toHaveBeenCalledWith(['hosts.db', 'history.db', 'config.json']);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });
});

describe('dev (не упакован) — manual-only не включается', () => {
  it('переменная portable не переключает dev в manual-only', () => {
    stand.packaged = false;
    process.env[ENV] = 'D:\\usb';
    initUpdater();
    expect(getStatus().manualOnly).toBe(false);
  });
});

describe('сторож отправителя', () => {
  it('чужой отправитель отклонён до обращения к updater', () => {
    vi.mocked(getMainWindow).mockReturnValueOnce(null);
    const handler = stand.handlers.get(IPC.updateCheck)!;
    expect(() => handler({ sender: {} } as unknown as IpcMainInvokeEvent)).toThrow();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });
});
