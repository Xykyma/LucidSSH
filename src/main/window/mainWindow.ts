import { app, BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { IPC } from '@shared/ipc';
import type { WindowState } from '@shared/config';
import { loadConfig, updateConfig } from '../config/store';
import { activeSessionCount, busySessions } from '../ssh/sessionManager';
import { emit } from '../ipc/events';
import { showOnReady } from './showOnReady';

/**
 * Главное окно: изоляция renderer (SEC-05) + сохранение/восстановление
 * размера и положения (WIN-01).
 */

/** Через сколько показать окно, если ready-to-show так и не пришёл. */
const SHOW_FALLBACK_MS = 4000;

let mainWindow: BrowserWindow | null = null;
let forceClose = false;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/** Пользователь подтвердил закрытие окна с активными сессиями (WIN-02). */
export function forceCloseWindow(): void {
  forceClose = true;
  mainWindow?.close();
}

/** Окно должно быть видимо хотя бы частично на одном из дисплеев. */
function boundsVisible(state: WindowState): boolean {
  if (state.x === undefined || state.y === undefined) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return (
      state.x! < a.x + a.width - 40 &&
      state.x! + state.width > a.x + 40 &&
      state.y! >= a.y - 10 &&
      state.y! < a.y + a.height - 40
    );
  });
}

function persistWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const maximized = win.isMaximized();
  const bounds = win.getNormalBounds();
  updateConfig((cfg) => {
    cfg.window = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized
    };
  });
}

export function createMainWindow(): BrowserWindow {
  const saved = loadConfig().window;
  const visible = boundsVisible(saved);

  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: visible ? saved.x : undefined,
    y: visible ? saved.y : undefined,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false, // кастомный тайтл-бар по дизайну (VS Code-style)
    backgroundColor: '#0F0F13',
    // Панель задач/Alt-Tab берут иконку окна отсюда, а не из ресурса .exe —
    // без этого показывается дефолтная иконка Electron (даже в упакованной
    // сборке с icon в electron-builder.yml, который влияет только на .exe/установщик).
    icon: join(app.getAppPath(), 'assets', 'icon.png'),
    webPreferences: {
      // SEC-05: обязательные флаги изоляции
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '../preload/index.js'),
      devTools: !app.isPackaged,
      spellcheck: false
    }
  });

  if (saved.maximized) mainWindow.maximize();

  // Без рабочего GPU (VM без 3D) ready-to-show может не прийти — тогда окно
  // показывается по таймеру, иначе приложение остаётся невидимым процессом.
  showOnReady(mainWindow, SHOW_FALLBACK_MS);

  // WIN-01: сохранение состояния с дебаунсом
  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (mainWindow) persistWindowState(mainWindow);
    }, 400);
  };
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);
  mainWindow.on('maximize', () => {
    scheduleSave();
    emit(IPC.evWindowMaximized, true);
  });
  mainWindow.on('unmaximize', () => {
    scheduleSave();
    emit(IPC.evWindowMaximized, false);
  });
  mainWindow.on('close', (event) => {
    // WIN-02: при активных сессиях требуется подтверждение перед закрытием.
    if (!forceClose && activeSessionCount() > 0) {
      event.preventDefault();
      // WIN-04: расширенный текст (список хост+команда) для сессий, которые
      // сейчас выполняют команду.
      emit(IPC.evConfirmWindowClose, activeSessionCount(), busySessions());
      return;
    }
    if (saveTimer) clearTimeout(saveTimer);
    if (mainWindow) persistWindowState(mainWindow);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Ссылки из renderer не открывают окна; внешние — только через SEC-08 поток.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return mainWindow;
}
