import { app, globalShortcut, Menu } from 'electron';
import { hardenApp, hardenCommandLine } from './security/hardening';
import { createMainWindow, getMainWindow } from './window/mainWindow';
import { registerIpcHandlers } from './ipc';
import { registerHostIpcHandlers } from './ipc/hosts';
import { registerSessionIpcHandlers } from './ipc/sessions';
import { registerConfigIpcHandlers } from './ipc/config';
import { registerContentIpcHandlers } from './ipc/content';
import { registerHistoryIpcHandlers } from './ipc/history';
import { registerSecurityIpcHandlers } from './ipc/security';
import { registerUpdateIpcHandlers } from './ipc/updates';
import { initUpdater, checkForUpdates } from './updates/updater';
import { initMainI18n } from './i18n';
import { openLocalStores } from './startup/openLocalStores';

/**
 * Точка входа main-процесса LucidSSH.
 * Порядок: hardening → single instance → ready → хранилища → i18n → IPC → окно.
 */

hardenCommandLine();

// Вторая копия приложения фокусирует существующее окно.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // AppUserModelID — чтобы системные тосты Windows атрибутировались приложению (NOTIF-01/02).
    app.setAppUserModelId('com.lucidssh.app');
    hardenApp();
    openLocalStores();
    await initMainI18n();
    registerIpcHandlers();
    registerHostIpcHandlers();
    registerSessionIpcHandlers();
    registerConfigIpcHandlers();
    registerContentIpcHandlers();
    registerHistoryIpcHandlers();
    registerSecurityIpcHandlers();
    registerUpdateIpcHandlers();
    createMainWindow();

    // Меню приложения отключено (кастомный тайтл-бар), поэтому стандартный
    // акселератор DevTools из меню недоступен — регистрируем свой, только в dev.
    if (!app.isPackaged) {
      const toggleDevTools = (): void => getMainWindow()?.webContents.toggleDevTools();
      globalShortcut.register('CommandOrControl+Shift+I', toggleDevTools);
      globalShortcut.register('F12', toggleDevTools);
    }

    // Автообновление (UPD-01): инициализация + неблокирующая проверка при запуске,
    // если она включена. Ошибки/офлайн глотаются молча внутри checkForUpdates.
    initUpdater();
    setTimeout(() => void checkForUpdates(false), 4000);
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}
