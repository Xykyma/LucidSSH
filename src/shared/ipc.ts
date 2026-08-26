import type { Breadcrumb } from './breadcrumb';
import type { ErrorExplanation } from './content';
import type { DashboardAlert, DashboardMetrics } from './dashboard';
import type { InteractiveProgramName } from './interactivePrograms';
import type { AuthPromptRequest, ConnectionLogEntry, HostKeyPrompt, SessionStatus } from './ssh';
import type { UpdateStatus } from './updates';

/**
 * Имена IPC-каналов. Каждый канал — одна конкретная операция (SEC-05, §4 гайда).
 * Универсальных каналов нет; renderer не передаёт имя канала как аргумент.
 */

export const IPC = {
  // --- Приложение ---
  appGetInfo: 'app:get-info',
  appOpenReleasesPage: 'app:open-releases-page', // §9.1 Release_and_Update_Strategy.md — ссылка на SHA-256 в About; переиспользуется и для «Список изменений» (SET-09) — тот же GitHub Releases
  appOpenBugReport: 'app:open-bug-report', // SET-09
  appOpenFeatureRequest: 'app:open-feature-request', // SET-09

  // --- Буфер обмена (через main, renderer без clipboard-permission) ---
  clipboardRead: 'clipboard:read',
  clipboardWrite: 'clipboard:write',

  // --- Настройки (config.json, без секретов) ---
  configGet: 'config:get',
  configUpdate: 'config:update',
  configUpdateHotkey: 'config:update-hotkey', // SET-10 — с проверкой конфликтов, отдельно от общего configUpdate
  configResetHotkeys: 'config:reset-hotkeys', // SET-10 — сброс только карты хоткеев, не всех настроек (в отличие от configReset/SET-08)
  configMarkHint: 'config:mark-hint', // счётчик показов подсказок (§5.1, SNIP-08)
  configResetHints: 'config:reset-hints', // «Сбросить счётчик показов подсказок» (SET-05)
  configReset: 'config:reset', // SET-08 сброс до заводских
  knownHostsList: 'security:known-hosts-list', // SET-04
  knownHostsDelete: 'security:known-hosts-delete',

  // --- i18n ---
  i18nGetResource: 'i18n:get-resource',
  i18nListLanguages: 'i18n:list-languages',
  i18nGetLanguage: 'i18n:get-language',
  i18nSetLanguage: 'i18n:set-language',

  // --- Хосты и группы (HM-01…HM-06) ---
  hostsList: 'hosts:list',
  hostCreate: 'hosts:create',
  hostUpdate: 'hosts:update',
  hostDelete: 'hosts:delete', // force-флаг вторым аргументом — SSH-05 тикет 05, обход предупреждения о jump-зависимостях
  hostHasSecret: 'hosts:has-secret',
  hostDeleteSecret: 'hosts:delete-secret',
  hostPickKeyFile: 'hosts:pick-key-file',
  hostKeyFileExists: 'hosts:key-file-exists', // HM-12 (тикет 01) — показ/скрытие «Создать новый ключ»
  hostsReorder: 'hosts:reorder',
  groupsList: 'groups:list',
  groupCreate: 'groups:create',
  groupRename: 'groups:rename',
  groupSetCollapsed: 'groups:set-collapsed',
  groupDelete: 'groups:delete',

  // DASH-09 «Больше не показывать»: канал про находку дашборда, hostId в ней —
  // лишь адрес, не CRUD хоста (.scratch/host-scoped-flags-to-db) — префикс
  // dashboard:, а не host:.
  dashboardDismissAlert: 'dashboard:dismiss-alert',

  // --- Мастер создания SSH-ключа (HM-12) ---
  keygenAvailable: 'keygen:available',
  keygenGenerate: 'keygen:generate',
  keygenSetPassphrase: 'keygen:set-passphrase',
  keygenOpenInstall: 'keygen:open-install', // инструкция включения «Клиент OpenSSH»

  // --- Экспорт / импорт (EXP-01…04) ---
  hostsExport: 'hosts:export',
  hostsImportPick: 'hosts:import-pick',
  hostsImportApply: 'hosts:import-apply',

  // --- Импорт из внешних источников (HM-03 PuTTY, HM-04 ssh_config, HM-10 WinSCP) ---
  importPuttyPreview: 'import:putty-preview',
  importSshConfigPreview: 'import:ssh-config-preview',
  importWinScpPreview: 'import:winscp-preview',
  importWinScpIniPreview: 'import:winscp-ini-preview',
  importExternalApply: 'import:external-apply',

  // --- SSH-сессии (SSH-01…07, CLOG) ---
  sessionConnect: 'session:connect',
  sessionConnectQuick: 'session:connect-quick',
  sessionDisconnect: 'session:disconnect',
  sessionDestroy: 'session:destroy',
  sessionList: 'session:list',
  sessionGetLog: 'session:get-log',
  sessionSendInput: 'session:send-input',
  sessionResize: 'session:resize',
  sessionTestConnection: 'session:test-connection',
  hostKeyConfirm: 'session:host-key-confirm',
  authPromptAnswer: 'session:auth-prompt-answer',

  // --- Страж опасных команд (GUARD-01…06) ---
  guardSubmit: 'guard:submit',
  guardConfirm: 'guard:confirm',
  guardCancel: 'guard:cancel',

  // --- Каталог команд / детектор ошибок (встроенные базы) ---
  catalogGet: 'catalog:get',

  // --- Автообновление (UPD-01…04) ---
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateGetStatus: 'update:get-status',

  // --- История команд (HIST-01…07) ---
  historyList: 'history:list',
  historyCount: 'history:count',
  historyAddNote: 'history:add-note',
  historyDelete: 'history:delete',
  historyClear: 'history:clear',

  // --- Сниппеты / избранное (SNIP-01…08) ---
  snippetsList: 'snippets:list',
  snippetCreate: 'snippets:create',
  snippetUpdate: 'snippets:update',
  snippetDelete: 'snippets:delete',
  snippetResolveHost: 'snippets:resolve-host',
  snippetHostHas: 'snippets:host-has',
  snippetsReorder: 'snippets:reorder',
  snippetFindDuplicate: 'snippets:find-duplicate',

  // --- Onboarding (OB-01…03) ---
  puttySessionsCount: 'onboarding:putty-count',

  // --- Управление окном (кастомный тайтл-бар) ---
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowConfirmClose: 'window:confirm-close',

  // --- События main → renderer ---
  evWindowMaximized: 'ev:window-maximized',
  evSessionStatus: 'ev:session-status',
  evHostKeyPrompt: 'ev:host-key-prompt',
  evAuthPrompt: 'ev:auth-prompt',
  evConnectionLog: 'ev:connection-log',
  evTerminalData: 'ev:terminal-data',
  evConfirmWindowClose: 'ev:confirm-window-close',
  evBreadcrumb: 'ev:breadcrumb',
  evDashboard: 'ev:dashboard',
  evDashboardAlert: 'ev:dashboard-alert', // DASH-09 — одноразовый health-баннер
  evError: 'ev:error',
  evUpdateStatus: 'ev:update-status',
  evHistoryRecorded: 'ev:history-recorded', // HistoryDrawer перечитывает список, если открыт
  evPasswordPrompt: 'ev:password-prompt', // TERM-09 — подсказка «ввод пароля скрыт»
  evIntegrationUnconfirmed: 'ev:integration-unconfirmed', // shell-интеграция не подтвердилась за echo-flush
  evInteractiveProgram: 'ev:interactive-program' // BRD-05 — запущена известная интерактивная программа
} as const;

export interface AppInfo {
  version: string;
  language: string;
}

/**
 * Контракт событий main → renderer (ADR-0011). Направление `ev:*` — единственное,
 * где main инициирует обмен: обратной стороны с ручной валидацией у него нет,
 * поэтому полезная нагрузка связывается типами, а не дисциплиной.
 *
 * Отправка — только через `emit()` из `src/main/ipc/events.ts` (правило ESLint
 * запрещает `webContents.send` мимо него). Приём — листенеры в `src/preload`.
 *
 * Оговорка ADR-0011: именованные элементы кортежа дают подсказку в IDE, но не
 * номинальную типизацию — перестановка двух соседних `string` (единственный
 * такой случай — `evTerminalData`) компилятором не ловится.
 */
export type RendererEvents = {
  [IPC.evWindowMaximized]: [maximized: boolean];
  [IPC.evSessionStatus]: [sessionId: string, status: SessionStatus];
  [IPC.evHostKeyPrompt]: [prompt: HostKeyPrompt];
  [IPC.evAuthPrompt]: [prompt: AuthPromptRequest];
  [IPC.evConnectionLog]: [sessionId: string, entry: ConnectionLogEntry];
  [IPC.evTerminalData]: [sessionId: string, data: string];
  [IPC.evConfirmWindowClose]: [
    activeCount: number,
    busySessions: Array<{ hostName: string; command: string }>
  ];
  [IPC.evBreadcrumb]: [sessionId: string, crumb: Breadcrumb];
  [IPC.evDashboard]: [sessionId: string, metrics: DashboardMetrics];
  [IPC.evDashboardAlert]: [sessionId: string, alert: DashboardAlert];
  [IPC.evError]: [sessionId: string, explanation: ErrorExplanation];
  [IPC.evUpdateStatus]: [status: UpdateStatus];
  [IPC.evHistoryRecorded]: [];
  [IPC.evPasswordPrompt]: [sessionId: string];
  [IPC.evIntegrationUnconfirmed]: [sessionId: string];
  [IPC.evInteractiveProgram]: [sessionId: string, program: InteractiveProgramName];
};

/** Все каналы `ev:*`, объявленные в `IPC` — выводятся из значений, не из списка. */
type EvChannel = Extract<(typeof IPC)[keyof typeof IPC], `ev:${string}`>;

/** Принимает только `never` — иначе не удовлетворяет ограничению параметра. */
type AssertNever<T extends never> = T;

/**
 * Полнота контракта на уровне компилятора: канал `ev:*`, не добавленный в
 * `RendererEvents`, остаётся в `Exclude` и роняет сборку здесь. Тест для этого
 * не нужен, и рантайм-значения тоже — это объявление типа, оно не доживает до
 * эмита, а не вычищается потом бандлером.
 */
export type RendererEventsAreComplete = AssertNever<Exclude<EvChannel, keyof RendererEvents>>;
