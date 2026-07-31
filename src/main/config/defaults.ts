import type { AppConfig } from '@shared/config';
import { detectSystemLanguage } from '../i18n/languages';

export function createDefaultConfig(appVersion: string): AppConfig {
  return {
    version: appVersion,
    // Автоопределение по локали ОС при первом запуске (нет config.json ещё);
    // если язык не поддержан — откат на ru (CLAUDE.md §5a).
    language: detectSystemLanguage(),
    window: {
      width: 1280,
      height: 800,
      maximized: false
    },
    onboarding: {
      completed: false
    },
    ui: {
      expertMode: false,
      hints: {
        commandCatalog: true,
        outputTooltips: true,
        errorPanel: true,
        connectionDialog: true
      },
      theme: 'dark',
      notifications: {
        systemToasts: true,
        longCommandThresholdSec: 30
      },
      dashboardVisible: true,
      catalogPanelOpen: true,
      hostPanelOpen: true,
      leftPanelWidth: 220,
      rightPanelWidth: 320
    },
    terminal: {
      font: 'JetBrains Mono',
      fontSize: 13,
      opacity: 1,
      bell: 'off',
      brightBold: true,
      selectToCopy: false,
      rightClickPaste: false
    },
    connection: {
      autoreconnect: true,
      keepaliveIntervalSec: 30,
      connectTimeoutSec: 15
    },
    guard: {
      globalEnabled: true
    },
    history: {
      enabled: true,
      perHostDisabled: []
    },
    dashboard: {
      dismissedAlerts: {}
    },
    shownCounts: {},
    pendingKeyDeployments: [],
    updates: {
      autoCheck: true,
      source: ''
    }
  };
}
