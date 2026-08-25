import type { PendingKeyDeployment } from './keygen';
import type { DashboardAlertIssue } from './dashboard';
import type { FixedHotkeyAction, HotkeyAction } from './hotkeys';

/**
 * Формат %APPDATA%\LucidSSH\config.json (Data_Structures.md §6).
 * Секретов здесь нет и быть не может (SEC-01).
 */

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean; // WIN-01
}

export interface AppConfig {
  version: string;
  /** Язык интерфейса (CLAUDE.md §5a): дефолт 'ru', fallback 'en'. */
  language: string;
  window: WindowState;
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
    perHostDisabled: number[];
  };
  dashboard: {
    /** DASH-09: «Больше не показывать» — issue не всплывает в health-баннере
     *  для этого хоста впредь (id хоста → список отклонённых находок). */
    dismissedAlerts: Record<number, DashboardAlertIssue[]>;
  };
  /** id подсказки → сколько раз показана (лимит 3, §5.1 ТЗ). */
  shownCounts: Record<string, number>;
  /** HM-12: ключи мастера, ждущие дозаписи на сервер — переживает перезапуск. */
  pendingKeyDeployments: PendingKeyDeployment[];
  updates: {
    autoCheck: boolean; // OQ-09
    source: string;
  };
}

/** Результат попытки перепривязать хоткей (config:update-hotkey). При
 *  конфликте `config` возвращается неизменным — записи не было (SET-10). */
export interface UpdateHotkeyResult {
  ok: boolean;
  config: AppConfig;
  conflictWith?: HotkeyAction | FixedHotkeyAction;
}
