import type { PendingKeyDeployment } from './keygen';
import type { DashboardAlertIssue } from './dashboard';
import type { FixedHotkeyAction, HotkeyAction } from './hotkeys';

/**
 * Формат %APPDATA%\LucidSSH\config.json (Data_Structures.md §6).
 * Секретов здесь нет и быть не может (SEC-01).
 *
 * Разрез по тому, кто инициирует запись (ADR-0014): `Settings` пишет окно
 * (обе стороны читают), `AppState` пишет main, окно его не видит. Формат
 * config.json не меняется — `AppConfig` остаётся пересечением обеих половин,
 * это только линия отдачи в renderer (`projectSettings`).
 */

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean; // WIN-01
}

/** Пишет окно, читают обе стороны. Это отдаётся в renderer целиком. */
export interface Settings {
  ui: {
    expertMode: boolean; // SET-05
    hints: {
      commandCatalog: boolean; // CAT-06
      outputTooltips: boolean;
      errorPanel: boolean; // ERR-03
      connectionDialog: boolean;
    };
    theme: 'dark'; // в 1.0 только тёмная
    notifications: {
      systemToasts: boolean; // NOTIF-04
      longCommandThresholdSec: number; // 0 = выкл. (NOTIF-02)
    };
    dashboardVisible: boolean; // DASH-04
    catalogPanelOpen: boolean;
    leftPanelWidth: number; // 160..340
    rightPanelWidth: number; // 200..480
  };
  terminal: {
    font: string; // TERM-04
    fontSize: number;
    opacity: number; // 0..1
    bell: 'off' | 'sound' | 'visual';
    brightBold: boolean;
    selectToCopy: boolean;
    rightClickPaste: boolean;
  };
  connection: {
    autoreconnect: boolean; // SSH-06, SET-03
    keepaliveIntervalSec: number;
    connectTimeoutSec: number;
  };
  guard: {
    globalEnabled: boolean; // GUARD-05
  };
  /** SET-10: биндинги 9 редактируемых хоткеев (issue #1). Esc/F1 не входят —
   *  зафиксированы, см. FIXED_HOTKEYS в shared/hotkeys.ts. */
  hotkeys: Record<HotkeyAction, string>;
  history: {
    enabled: boolean; // HIST-07
  };
  /** id подсказки → сколько раз показана (лимит 3, §5.1 ТЗ). */
  shownCounts: Record<string, number>;
  updates: {
    autoCheck: boolean; // OQ-09
  };
}

/** Пишет main, окно не видит — `projectSettings` вычёркивает это при отдаче в IPC. */
export interface AppState {
  version: string;
  /** Язык интерфейса (CLAUDE.md §5a): дефолт 'ru', fallback 'en'. Пишется
   *  только через changeMainLanguage() (i18n:set-language) — путь `language`
   *  в `WRITABLE` (config:update) отсутствует намеренно, не по недосмотру. */
  language: string;
  window: WindowState;
  /** HM-12: ключи мастера, ждущие дозаписи на сервер — переживает перезапуск. */
  pendingKeyDeployments: PendingKeyDeployment[];
  dashboard: {
    /** DASH-09: «Больше не показывать» — issue не всплывает в health-баннере
     *  для этого хоста впредь (id хоста → список отклонённых находок). Пишут
     *  обе стороны (окно жмёт «не показывать», main сам снимает mute при
     *  self-clearing), но владелец — main. */
    dismissedAlerts: Record<number, DashboardAlertIssue[]>;
  };
  history: {
    perHostDisabled: number[];
  };
  updates: {
    source: string;
  };
}

/** Форма файла на диске — этим разрезом не меняется. */
export type AppConfig = Settings & AppState;

/**
 * Проекция для renderer — явный литерал, не спред: забытое поле `Settings`
 * ловит компилятор (возвращаемый тип не удовлетворён), утечку `AppState`
 * ловит то, что литерал явный, а не `Omit`/спред.
 */
export function projectSettings(cfg: AppConfig): Settings {
  return {
    ui: cfg.ui,
    terminal: cfg.terminal,
    connection: cfg.connection,
    guard: cfg.guard,
    hotkeys: cfg.hotkeys,
    history: { enabled: cfg.history.enabled },
    shownCounts: cfg.shownCounts,
    updates: { autoCheck: cfg.updates.autoCheck }
  };
}

/** Обратная проекция — нужна только SET-08 (resetConfig): то, что должно
 *  пережить сброс настроек, потому что владеет им main, а не окно. */
export function projectState(cfg: AppConfig): AppState {
  return {
    version: cfg.version,
    language: cfg.language,
    window: cfg.window,
    pendingKeyDeployments: cfg.pendingKeyDeployments,
    dashboard: cfg.dashboard,
    history: { perHostDisabled: cfg.history.perHostDisabled },
    updates: { source: cfg.updates.source }
  };
}

/** Собирает файл на диске обратно из двух половин (SET-08). `history` и
 *  `updates` разрезаны вложенно — наивный спред одной половины поверх другой
 *  стёр бы соседнее поле того же вложенного объекта. */
export function combineConfig(settings: Settings, state: AppState): AppConfig {
  return {
    ...settings,
    ...state,
    history: { ...settings.history, ...state.history },
    updates: { ...settings.updates, ...state.updates }
  };
}

/** Результат попытки перепривязать хоткей (config:update-hotkey). При
 *  конфликте `config` возвращается неизменным — записи не было (SET-10). */
export interface UpdateHotkeyResult {
  ok: boolean;
  config: Settings;
  conflictWith?: HotkeyAction | FixedHotkeyAction;
}
