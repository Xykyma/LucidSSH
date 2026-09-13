import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc';
import { projectSettings, type Settings, type UpdateHotkeyResult } from '@shared/config';
import { INTERACTIVE_PROGRAMS } from '@shared/interactivePrograms';
import {
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  findHotkeyConflict,
  isValidHotkeyCombo,
  type HotkeyAction
} from '@shared/hotkeys';
import { loadConfig, updateConfig } from '../config/store';
import { assertSenderIsMainWindow, assertString, IpcValidationError } from './validate';

/**
 * Чтение и точечное обновление config.json (SET-07 — запись немедленно).
 * config.json не содержит секретов (SEC-01), поэтому его можно отдавать в renderer.
 * Обновление принимает только известные пути с провалидированным значением —
 * произвольная замена структуры запрещена.
 */

type Primitive = string | number | boolean;

/** Плоские пути настроек, которые renderer вправе менять. Принимает `Settings`,
 *  не `AppConfig` (ADR-0014): путь `language` отсюда вычеркнут, а не запрещён
 *  отдельной проверкой — попытка написать здесь `cfg.language = v` не пройдёт
 *  компиляцию, потому что `Settings` этого поля не объявляет. */
const WRITABLE: Record<string, (v: unknown, cfg: Settings) => void> = {
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
  ipcMain.handle(IPC.configGet, (event): Settings => {
    assertSenderIsMainWindow(event);
    return projectSettings(loadConfig());
  });

  ipcMain.handle(IPC.configUpdate, (event, rawPath: unknown, value: unknown): Settings => {
    assertSenderIsMainWindow(event);
    if (typeof rawPath !== 'string' || !Object.hasOwn(WRITABLE, rawPath)) {
      throw new IpcValidationError('path: unknown setting');
    }
    const setter = WRITABLE[rawPath]!;
    return projectSettings(updateConfig((cfg) => setter(value as Primitive, cfg)));
  });

  // SET-10 (issue #1): перепривязка редактируемого хоткея — с проверкой
  // конфликтов против остальных редактируемых действий и зафиксированных
  // Esc/F1 (findHotkeyConflict). При конфликте запись не происходит, ответ
  // называет действие-владельца, чтобы UI показал сообщение (не троит через throw —
  // конфликт это ожидаемый исход взаимодействия, а не программная ошибка).
  ipcMain.handle(
    IPC.configUpdateHotkey,
    (event, rawAction: unknown, rawCombo: unknown): UpdateHotkeyResult => {
      assertSenderIsMainWindow(event);
      if (typeof rawAction !== 'string' || !(HOTKEY_ACTIONS as readonly string[]).includes(rawAction)) {
        throw new IpcValidationError('action: unknown');
      }
      const combo = assertString(rawCombo, 'combo', 40);
      if (!isValidHotkeyCombo(combo)) {
        throw new IpcValidationError('combo: invalid format');
      }
      const action = rawAction as HotkeyAction;
      const cfg = loadConfig();
      const conflictWith = findHotkeyConflict(combo, cfg.hotkeys, action) ?? undefined;
      if (conflictWith) return { ok: false, config: projectSettings(cfg), conflictWith };
      const next = updateConfig((c) => {
        c.hotkeys[action] = combo;
      });
      return { ok: true, config: projectSettings(next) };
    }
  );

  // «Сбросить хоткеи к заводским» — точечный сброс только карты хоткеев
  // (в отличие от configReset/SET-08, который сбрасывает вообще все настройки).
  ipcMain.handle(IPC.configResetHotkeys, (event): Settings => {
    assertSenderIsMainWindow(event);
    return projectSettings(
      updateConfig((cfg) => {
        cfg.hotkeys = { ...DEFAULT_HOTKEYS };
      })
    );
  });

  // Счётчик показов одноразовых подсказок (§5.1, SNIP-08). Только известные id.
  ipcMain.handle(IPC.configMarkHint, (event, rawId: unknown): Settings => {
    assertSenderIsMainWindow(event);
    if (!KNOWN_HINTS.has(rawId as string)) throw new IpcValidationError('hintId: unknown');
    const id = rawId as string;
    return projectSettings(
      updateConfig((cfg) => {
        cfg.shownCounts[id] = (cfg.shownCounts[id] ?? 0) + 1;
      })
    );
  });

  // «Сбросить счётчик показов подсказок» (Настройки → Интерфейс) — обнуляет
  // все известные счётчики, подсказки снова показываются до своего лимита.
  ipcMain.handle(IPC.configResetHints, (event): Settings => {
    assertSenderIsMainWindow(event);
    return projectSettings(
      updateConfig((cfg) => {
        for (const id of KNOWN_HINTS) cfg.shownCounts[id] = 0;
      })
    );
  });
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
