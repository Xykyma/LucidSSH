import electronUpdater from 'electron-updater';
import { IPC } from '@shared/ipc';
import type { UpdateInfo, UpdateProgress, UpdateStatus } from '@shared/updates';
import { app } from 'electron';
import { emit } from '../ipc/events';
import { loadConfig } from '../config/store';
import { writePreUpdateBackup } from '../history/backups';
import { isAutoUpdateSupported } from './autoUpdateSupport';

/**
 * Автообновление (UPD-01…04, SEC-06/07). Обновление тянется только с публичного
 * GitHub Releases по HTTPS; данные о хостах/сессиях наружу не уходят.
 * autoDownload/autoInstall выключены — скачивание и установка только по явному
 * согласию (UPD-02). Подпись и издателя проверяет electron-updater в main перед
 * установкой (UPD-03); без сертификата (BLK-01) проверка активируется, когда
 * приложение будет подписано. Manual-only сборки (.deb, portable Windows,
 * NFR-05 тикет 07) никогда не вызывают electron-updater: проверка, скачивание
 * и установка — no-op, в интерфейсе — ручной переход на Releases.
 */

const { autoUpdater } = electronUpdater;

let status: UpdateStatus = {
  state: 'idle',
  notConfigured: true,
  manualOnly: false,
  currentVersion: '0.0.0'
};

/** Почему сборка manual-only: portable exe не заменяет собственные файлы (07). */
function manualReason(): UpdateStatus['manualReason'] {
  if (!app.isPackaged) return undefined;
  if (isAutoUpdateSupported(process.platform, process.env)) return undefined;
  return process.platform === 'win32' ? 'portable' : 'deb';
}

const manualOnly = (): boolean => manualReason() !== undefined;

function send(): void {
  emit(IPC.evUpdateStatus, status);
}

function setStatus(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch };
  send();
}

/** "owner/repo" из настроек → провайдер GitHub. Пусто → источник не настроен. */
function parseSource(source: string): { owner: string; repo: string } | null {
  const m = source.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** Фид не настроен: dev-сборка без override источника (в упакованном — app-update.yml). */
function isNotConfigured(): boolean {
  return !manualOnly() && parseSource(loadConfig().updates.source) === null && !app.isPackaged;
}

export function initUpdater(): void {
  const reason = manualReason();
  status = {
    state: 'idle',
    notConfigured: isNotConfigured(),
    manualReason: reason,
    manualOnly: reason !== undefined,
    currentVersion: app.getVersion()
  };

  autoUpdater.autoDownload = false; // UPD-02: скачивание только по согласию
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    const ui: UpdateInfo = {
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      releaseDate: info.releaseDate
    };
    setStatus({ state: 'available', info: ui, progress: undefined });
  });
  autoUpdater.on('update-not-available', () => setStatus({ state: 'not-available', info: undefined }));
  autoUpdater.on('download-progress', (p) => {
    const progress: UpdateProgress = {
      percent: p.percent,
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total
    };
    setStatus({ state: 'downloading', progress });
  });
  autoUpdater.on('update-downloaded', () => setStatus({ state: 'downloaded' }));
  autoUpdater.on('error', () => {
    // Ошибка (в т.ч. офлайн) не должна быть навязчивой (UPD-01) — фиксируем тихо
    setStatus({ state: 'error', errorKey: 'updates.error.generic' });
  });
}

/**
 * Проверка обновлений. Авто — только если включена автопроверка (OQ-09);
 * ручная — всегда. Источник не настроен или dev-сборка → тихий no-op (UPD-01).
 */
export async function checkForUpdates(manual: boolean): Promise<void> {
  if (manualOnly()) return; // manual-only (.deb/portable): вручную, autoUpdater не зовём
  const cfg = loadConfig();
  const source = parseSource(cfg.updates.source);
  if (source === null && !app.isPackaged) {
    setStatus({ state: 'not-available', notConfigured: true });
    return; // dev без override — проверять нечего
  }
  if (!manual && !cfg.updates.autoCheck) return; // автопроверка отключена
  setStatus({ notConfigured: false });
  try {
    // Источник из настроек переопределяет встроенный app-update.yml
    if (source) autoUpdater.setFeedURL({ provider: 'github', owner: source.owner, repo: source.repo });
    await autoUpdater.checkForUpdates();
  } catch {
    // Не навязчиво (UPD-01): офлайн / нет фида / не упаковано — молча
    setStatus({ state: 'not-available' });
  }
}

export async function downloadUpdate(): Promise<void> {
  if (manualOnly()) return; // manual-only: скачивание запрещено (тикет 07)
  try {
    await autoUpdater.downloadUpdate();
  } catch {
    setStatus({ state: 'error', errorKey: 'updates.error.download' });
  }
}

/** UPD-04: бэкап БД перед установкой, затем перезапуск. Manual-only: no-op. */
export function installUpdate(): void {
  if (manualOnly()) return; // ни бэкапа, ни перезапуска — операция запрещена (тикет 07)
  backupDatabases();
  autoUpdater.quitAndInstall(false, true);
}

export function getStatus(): UpdateStatus {
  return status;
}

/** Копия БД и config перед обновлением (UPD-04). Секреты в keychain не затрагиваются. */
function backupDatabases(): void {
  try {
    writePreUpdateBackup(['hosts.db', 'history.db', 'config.json']);
  } catch {
    // Бэкап — «лучшее усилие»; при сбое обновление всё равно возможно
  }
}
