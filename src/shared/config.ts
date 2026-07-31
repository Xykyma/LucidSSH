import type { PendingKeyDeployment } from './keygen';
import type { DashboardAlertIssue } from './dashboard';

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
  onboarding: {
    completed: boolean; // OB-03
  };
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
    hostPanelOpen: boolean; // Ctrl+0 toggle
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
