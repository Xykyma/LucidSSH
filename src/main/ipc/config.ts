import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc';
import type { AppConfig } from '@shared/config';
import { DASHBOARD_ALERT_ISSUES, type DashboardAlertIssue } from '@shared/dashboard';
import { INTERACTIVE_PROGRAMS } from '@shared/interactivePrograms';
import { loadConfig, updateConfig } from '../config/store';
import { assertSenderIsMainWindow, IpcValidationError } from './validate';

/**
 * Чтение и точечное обновление config.json (SET-07 — запись немедленно).
 * config.json не содержит секретов (SEC-01), поэтому его можно отдавать в renderer.
 * Обновление принимает только известные пути с провалидированным значением —
 * произвольная замена структуры запрещена.
 */

type Primitive = string | number | boolean;

/** Плоские пути настроек, которые renderer вправе менять. */
const WRITABLE: Record<string, (v: unknown, cfg: AppConfig) => void> = {
  'language': (v, cfg) => {
    if (typeof v === 'string') cfg.language = v;
  },
  'ui.expertMode': (v, cfg) => setBool(v, (b) => (cfg.ui.expertMode = b)),
  'ui.hints.commandCatalog': (v, cfg) => setBool(v, (b) => (cfg.ui.hints.commandCatalog = b)),
  'ui.hints.outputTooltips': (v, cfg) => setBool(v, (b) => (cfg.ui.hints.outputTooltips = b)),
  'ui.hints.errorPanel': (v, cfg) => setBool(v, (b) => (cfg.ui.hints.errorPanel = b)),
  'ui.hints.connectionDialog': (v, cfg) => setBool(v, (b) => (cfg.ui.hints.connectionDialog = b)),
  'ui.notifications.systemToasts': (v, cfg) =>
    setBool(v, (b) => (cfg.ui.notifications.systemToasts = b)),
  'ui.notifications.longCommandThresholdSec': (v, cfg) =>
    setNum(v, 0, 86400, (n) => (cfg.ui.notifications.longCommandThresholdSec = n)),
  'ui.dashboardVisible': (v, cfg) => setBool(v, (b) => (cfg.ui.dashboardVisible = b)),
  'ui.catalogPanelOpen': (v, cfg) => setBool(v, (b) => (cfg.ui.catalogPanelOpen = b)),
  'ui.hostPanelOpen': (v, cfg) => setBool(v, (b) => (cfg.ui.hostPanelOpen = b)),
  'ui.leftPanelWidth': (v, cfg) => setNum(v, 160, 340, (n) => (cfg.ui.leftPanelWidth = n)),
  'ui.rightPanelWidth': (v, cfg) => setNum(v, 200, 480, (n) => (cfg.ui.rightPanelWidth = n)),
  'terminal.font': (v, cfg) => {
    if (typeof v === 'string' && v.length <= 80) cfg.terminal.font = v;
  },
  'terminal.fontSize': (v, cfg) => setNum(v, 8, 32, (n) => (cfg.terminal.fontSize = n)),
  'terminal.opacity': (v, cfg) => setNum(v, 0.3, 1, (n) => (cfg.terminal.opacity = n)),
  'terminal.bell': (v, cfg) => {
    if (v === 'off' || v === 'sound' || v === 'visual') cfg.terminal.bell = v;
  },
  'terminal.brightBold': (v, cfg) => setBool(v, (b) => (cfg.terminal.brightBold = b)),
  'terminal.selectToCopy': (v, cfg) => setBool(v, (b) => (cfg.terminal.selectToCopy = b)),
  'terminal.rightClickPaste': (v, cfg) => setBool(v, (b) => (cfg.terminal.rightClickPaste = b)),
  'connection.autoreconnect': (v, cfg) => setBool(v, (b) => (cfg.connection.autoreconnect = b)),
  'connection.keepaliveIntervalSec': (v, cfg) =>
    setNum(v, 5, 3600, (n) => (cfg.connection.keepaliveIntervalSec = n)),
  'connection.connectTimeoutSec': (v, cfg) =>
    setNum(v, 3, 120, (n) => (cfg.connection.connectTimeoutSec = n)),
  'guard.globalEnabled': (v, cfg) => setBool(v, (b) => (cfg.guard.globalEnabled = b)),
  'history.enabled': (v, cfg) => setBool(v, (b) => (cfg.history.enabled = b)),
  'updates.autoCheck': (v, cfg) => setBool(v, (b) => (cfg.updates.autoCheck = b))
};

function setBool(v: unknown, apply: (b: boolean) => void): void {
  if (typeof v !== 'boolean') throw new IpcValidationError('value: boolean expected');
  apply(v);
}
function setNum(v: unknown, min: number, max: number, apply: (n: number) => void): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new IpcValidationError('value: out of range');
  }
  apply(v);
}

export function registerConfigIpcHandlers(): void {
  ipcMain.handle(IPC.configGet, (event): AppConfig => {
    assertSenderIsMainWindow(event);
    return loadConfig();
  });

  ipcMain.handle(IPC.configUpdate, (event, rawPath: unknown, value: unknown): AppConfig => {
    assertSenderIsMainWindow(event);
    if (typeof rawPath !== 'string' || !(rawPath in WRITABLE)) {
      throw new IpcValidationError('path: unknown setting');
    }
    const setter = WRITABLE[rawPath]!;
    return updateConfig((cfg) => setter(value as Primitive, cfg));
  });

  // Счётчик показов одноразовых подсказок (§5.1, SNIP-08). Только известные id.
  ipcMain.handle(IPC.configMarkHint, (event, rawId: unknown): AppConfig => {
    assertSenderIsMainWindow(event);
    if (!KNOWN_HINTS.has(rawId as string)) throw new IpcValidationError('hintId: unknown');
    const id = rawId as string;
    return updateConfig((cfg) => {
      cfg.shownCounts[id] = (cfg.shownCounts[id] ?? 0) + 1;
    });
  });

  // «Сбросить счётчик показов подсказок» (Настройки → Интерфейс) — обнуляет
  // все известные счётчики, подсказки снова показываются до своего лимита.
  ipcMain.handle(IPC.configResetHints, (event): AppConfig => {
    assertSenderIsMainWindow(event);
    return updateConfig((cfg) => {
      for (const id of KNOWN_HINTS) cfg.shownCounts[id] = 0;
    });
  });

  // DASH-09: «Больше не показывать» для конкретной находки на конкретном хосте —
  // health-баннер main-процесса сверяется с этим списком перед отправкой (dashboard.ts).
  ipcMain.handle(
    IPC.configDismissDashboardAlert,
    (event, rawHostId: unknown, rawIssue: unknown): AppConfig => {
      assertSenderIsMainWindow(event);
      if (typeof rawHostId !== 'number' || !Number.isInteger(rawHostId)) {
        throw new IpcValidationError('hostId: integer expected');
      }
      if (!(DASHBOARD_ALERT_ISSUES as readonly string[]).includes(rawIssue as string)) {
        throw new IpcValidationError('issue: unknown');
      }
      const issue = rawIssue as DashboardAlertIssue;
      return updateConfig((cfg) => {
        const list = cfg.dashboard.dismissedAlerts[rawHostId] ?? [];
        if (!list.includes(issue)) cfg.dashboard.dismissedAlerts[rawHostId] = [...list, issue];
      });
    }
  );
}

/** Разрешённые id подсказок (обучающие подсказки с лимитом показов). */
const KNOWN_HINTS = new Set([
  'snippetHint',
  'onboardingTips',
  'ctrlcHint',
  'snippetPaletteHint',
  'rootHint',
  'passwordHint',
  // BRD-06: счётчик показов хоткеев — отдельный на каждую интерактивную программу.
  ...INTERACTIVE_PROGRAMS.map((program) => `interactiveHotkeys.${program}`)
]);
