import { app, dialog, globalShortcut, Menu } from 'electron';
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
import { initMainI18n, t } from './i18n';
import { openLocalStores } from './startup/openLocalStores';
import { prepareProfileIdentity } from './startup/profileIdentity';
import { checkProfileWritability } from './startup/profileWritability';
import { loadConfig } from './config/store';

/**
 * Точка входа main-процесса LucidSSH.
 * Порядок: hardening → single instance → ready → идентичность профиля →
 * хранилища → i18n → IPC → окно.
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
    // Идентичность Переносимого профиля (NFR-05): читается/создаётся до
    // конфигурации, БД, миграций и остальных файлов. Отказ — блокирующая
    // локализованная ошибка без fallback и без изменения данных профиля.
    const identity = prepareProfileIdentity();
    if (!identity.ok) {
      // Язык — из конфигурации; при её повреждении loadConfig даёт дефолт (ru),
      // идентичность профиля это уже не меняет. Базы не открываем: читаем только
      // язык, файлов профиля при этом не создаётся и не меняется.
      loadConfig();
      await initMainI18n();
      dialog.showErrorBox(t('profileIdentity.error.title'), t(`profileIdentity.error.${identity.error}`));
      app.quit();
      return;
    }
    // Записываемость Переносимого профиля (NFR-05): реальные пробы записи до
    // открытия хранилищ и миграций. Отказ — блокирующая локализованная ошибка
    // с именем проблемного файла; fallback, read-only и частичный запуск
    // без сохранения запрещены.
    const writability = checkProfileWritability();
    if (!writability.ok) {
      // Язык — из конфигурации; базы не открываем: файлов профиля при этом
      // не создаётся и не меняется (см. ветку идентичности выше).
      loadConfig();
      await initMainI18n();
      dialog.showErrorBox(
        t('profileWritability.error.title'),
        t('profileWritability.error.message', { file: writability.file })
      );
      app.quit();
      return;
    }
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
