import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AppInfo, type RendererEvents } from '@shared/ipc';
import type { Host, HostGroup, HostInput, ImportPreview } from '@shared/hosts';
import type { ExternalImportApplyResult, ExternalImportResult, ImportedHost } from '@shared/import';
import type {
  AuthPromptRequest,
  ConnectionLogEntry,
  HostKeyPrompt,
  KnownHostView,
  SessionInfo,
  SessionStatus,
  TestConnectionResult
} from '@shared/ssh';
import type { AppConfig, UpdateHotkeyResult } from '@shared/config';
import type { HotkeyAction } from '@shared/hotkeys';
import type { SubmitResult } from '@shared/guard';
import type { Breadcrumb } from '@shared/breadcrumb';
import type { DashboardAlert, DashboardAlertIssue, DashboardMetrics } from '@shared/dashboard';
import type { CommandsDatabase, ErrorExplanation } from '@shared/content';
import type { HistoryEntry, HistoryQuery, Snippet } from '@shared/history';
import type { UpdateStatus } from '@shared/updates';
import type { KeygenGenerateRequest, KeygenGenerateResult } from '@shared/keygen';
import type { InteractiveProgramName } from '@shared/interactivePrograms';

/**
 * Минимальный preload (SEC-05): только конкретные операции,
 * никаких универсальных send/invoke, никакого доступа к Node из renderer.
 */

/**
 * Подписка на событие main → renderer по контракту `RendererEvents` (ADR-0011).
 * Приём связан той же картой, что и отправка в `src/main/ipc/events.ts`:
 * колбэк, чья сигнатура не совпадает с объявленной полезной нагрузкой,
 * не скомпилируется.
 *
 * Приведение `args` неизбежно — `ipcRenderer.on` отдаёт нетипизированный
 * список: контракт описывает то, что кладёт `emit`, а не то, что проверяется
 * в рантайме. Это единственная точка приведения на все 16 событий.
 */
function subscribe<K extends keyof RendererEvents>(
  channel: K,
  cb: (...args: RendererEvents[K]) => void
): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void =>
    cb(...(args as RendererEvents[K]));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  // --- Приложение ---
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appGetInfo),
  openReleasesPage: (): void => ipcRenderer.send(IPC.appOpenReleasesPage),
  openBugReport: (): void => ipcRenderer.send(IPC.appOpenBugReport),
  openFeatureRequest: (): void => ipcRenderer.send(IPC.appOpenFeatureRequest),

  // --- Буфер обмена ---
  clipboardRead: (): Promise<string> => ipcRenderer.invoke(IPC.clipboardRead),
  clipboardWrite: (text: string): void => ipcRenderer.send(IPC.clipboardWrite, text),

  // --- Настройки ---
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.configGet),
  updateConfig: (path: string, value: string | number | boolean): Promise<AppConfig> =>
    ipcRenderer.invoke(IPC.configUpdate, path, value),
  updateHotkey: (action: HotkeyAction, combo: string): Promise<UpdateHotkeyResult> =>
    ipcRenderer.invoke(IPC.configUpdateHotkey, action, combo),
  resetHotkeys: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.configResetHotkeys),
  resetConfig: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.configReset),
  markHint: (hintId: string): Promise<AppConfig> => ipcRenderer.invoke(IPC.configMarkHint, hintId),
  resetHintCounters: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.configResetHints),
  dismissDashboardAlert: (hostId: number, issue: DashboardAlertIssue): Promise<AppConfig> =>
    ipcRenderer.invoke(IPC.configDismissDashboardAlert, hostId, issue),
  listKnownHosts: (): Promise<KnownHostView[]> => ipcRenderer.invoke(IPC.knownHostsList),
  deleteKnownHost: (line: number): Promise<void> => ipcRenderer.invoke(IPC.knownHostsDelete, line),

  // --- i18n ---
  i18nGetResource: (lng: string, ns: string): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke(IPC.i18nGetResource, lng, ns),
  i18nListLanguages: (): Promise<string[]> => ipcRenderer.invoke(IPC.i18nListLanguages),
  i18nGetLanguage: (): Promise<string> => ipcRenderer.invoke(IPC.i18nGetLanguage),
  i18nSetLanguage: (lng: string): Promise<void> => ipcRenderer.invoke(IPC.i18nSetLanguage, lng),

  // --- Хосты и группы (HM-01…HM-06) ---
  listHosts: (): Promise<Host[]> => ipcRenderer.invoke(IPC.hostsList),
  listGroups: (): Promise<HostGroup[]> => ipcRenderer.invoke(IPC.groupsList),
  // secret сразу уходит в keychain в main и не возвращается (SEC-01)
  createHost: (input: HostInput, secret?: string): Promise<{ id: number }> =>
    ipcRenderer.invoke(IPC.hostCreate, input, secret),
  updateHost: (id: number, input: HostInput, secret?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.hostUpdate, id, input, secret),
  // SSH-05 тикет 05: без force удаление хоста, используемого как jump-хост,
  // не проходит — возвращается { deleted: false, dependents } для предупреждения.
  deleteHost: (
    id: number,
    force?: boolean
  ): Promise<{ deleted: true } | { deleted: false; dependents: Host[] }> =>
    ipcRenderer.invoke(IPC.hostDelete, id, force),
  reorderHosts: (orderedIds: number[]): Promise<void> =>
    ipcRenderer.invoke(IPC.hostsReorder, orderedIds),
  hostHasSecret: (id: number): Promise<boolean> => ipcRenderer.invoke(IPC.hostHasSecret, id),
  hostDeleteSecret: (id: number): Promise<void> => ipcRenderer.invoke(IPC.hostDeleteSecret, id),
  pickKeyFile: (): Promise<string | null> => ipcRenderer.invoke(IPC.hostPickKeyFile),
  keyFileExists: (path: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.hostKeyFileExists, path),
  createGroup: (name: string): Promise<{ id: number }> => ipcRenderer.invoke(IPC.groupCreate, name),
  renameGroup: (id: number, name: string): Promise<void> =>
    ipcRenderer.invoke(IPC.groupRename, id, name),
  setGroupCollapsed: (id: number, collapsed: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.groupSetCollapsed, id, collapsed),
  deleteGroup: (id: number): Promise<void> => ipcRenderer.invoke(IPC.groupDelete, id),

  // --- Мастер создания SSH-ключа (HM-12) ---
  keygenAvailable: (): Promise<boolean> => ipcRenderer.invoke(IPC.keygenAvailable),
  keygenGenerate: (req: KeygenGenerateRequest): Promise<KeygenGenerateResult> =>
    ipcRenderer.invoke(IPC.keygenGenerate, req),
  keygenSetPassphrase: (keyPath: string, passphrase: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.keygenSetPassphrase, keyPath, passphrase),
  keygenOpenInstall: (): void => ipcRenderer.send(IPC.keygenOpenInstall),

  // --- Экспорт / импорт (EXP-01…04) ---
  exportHosts: (): Promise<{ saved: boolean }> => ipcRenderer.invoke(IPC.hostsExport),
  pickImportHosts: (): Promise<{ json: string; preview: ImportPreview } | null> =>
    ipcRenderer.invoke(IPC.hostsImportPick),
  applyImportHosts: (
    json: string,
    strategy: 'skip' | 'rename'
  ): Promise<{ imported: number; skipped: number }> =>
    ipcRenderer.invoke(IPC.hostsImportApply, json, strategy),
  importPuttyPreview: (): Promise<ExternalImportResult> =>
    ipcRenderer.invoke(IPC.importPuttyPreview),
  importSshConfigPreview: (): Promise<ExternalImportResult | null> =>
    ipcRenderer.invoke(IPC.importSshConfigPreview),
  importWinScpPreview: (): Promise<ExternalImportResult> =>
    ipcRenderer.invoke(IPC.importWinScpPreview),
  importWinScpIniPreview: (): Promise<ExternalImportResult | null> =>
    ipcRenderer.invoke(IPC.importWinScpIniPreview),
  applyExternalImport: (
    hosts: ImportedHost[],
    strategy: 'skip' | 'rename'
  ): Promise<ExternalImportApplyResult> =>
    ipcRenderer.invoke(IPC.importExternalApply, hosts, strategy),

  // --- SSH-сессии (SSH-01…07, CLOG) ---
  connectHost: (hostId: number): Promise<{ sessionId: string }> =>
    ipcRenderer.invoke(IPC.sessionConnect, hostId),
  connectQuick: (input: string): Promise<{ sessionId: string }> =>
    ipcRenderer.invoke(IPC.sessionConnectQuick, input),
  disconnectSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.sessionDisconnect, sessionId),
  destroySession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.sessionDestroy, sessionId),
  listSessions: (): Promise<SessionInfo[]> => ipcRenderer.invoke(IPC.sessionList),
  getConnectionLog: (sessionId: string): Promise<ConnectionLogEntry[]> =>
    ipcRenderer.invoke(IPC.sessionGetLog, sessionId),
  confirmHostKey: (requestId: string, decision: 'accept' | 'reject'): Promise<void> =>
    ipcRenderer.invoke(IPC.hostKeyConfirm, requestId, decision),
  answerAuthPrompt: (requestId: string, answers: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC.authPromptAnswer, requestId, answers),
  testConnection: (
    input: HostInput,
    secret?: string,
    hostId?: number
  ): Promise<TestConnectionResult> =>
    ipcRenderer.invoke(IPC.sessionTestConnection, input, secret, hostId),

  // --- Страж (команда идёт на сервер только через эту проверку) ---
  submitCommand: (sessionId: string, command: string): Promise<SubmitResult> =>
    ipcRenderer.invoke(IPC.guardSubmit, sessionId, command),
  confirmDangerousCommand: (requestId: string, confirmationText: string): Promise<{ allowed: boolean }> =>
    ipcRenderer.invoke(IPC.guardConfirm, requestId, confirmationText),
  cancelDangerousCommand: (requestId: string): void => ipcRenderer.send(IPC.guardCancel, requestId),
  sendTerminalInput: (sessionId: string, data: string): Promise<SubmitResult> =>
    ipcRenderer.invoke(IPC.sessionSendInput, sessionId, data),
  resizeSession: (sessionId: string, cols: number, rows: number): void =>
    ipcRenderer.send(IPC.sessionResize, sessionId, cols, rows),
  onTerminalData: (cb: (sessionId: string, data: string) => void): (() => void) =>
    subscribe(IPC.evTerminalData, cb),
  onSessionStatus: (cb: (sessionId: string, status: SessionStatus) => void): (() => void) =>
    subscribe(IPC.evSessionStatus, cb),
  onHostKeyPrompt: (cb: (prompt: HostKeyPrompt) => void): (() => void) =>
    subscribe(IPC.evHostKeyPrompt, cb),
  onAuthPrompt: (cb: (prompt: AuthPromptRequest) => void): (() => void) =>
    subscribe(IPC.evAuthPrompt, cb),
  onConnectionLog: (cb: (sessionId: string, entry: ConnectionLogEntry) => void): (() => void) =>
    subscribe(IPC.evConnectionLog, cb),
  onBreadcrumb: (cb: (sessionId: string, crumb: Breadcrumb) => void): (() => void) =>
    subscribe(IPC.evBreadcrumb, cb),
  onHistoryRecorded: (cb: () => void): (() => void) => subscribe(IPC.evHistoryRecorded, cb),
  onPasswordPrompt: (cb: (sessionId: string) => void): (() => void) =>
    subscribe(IPC.evPasswordPrompt, cb),
  onIntegrationUnconfirmed: (cb: (sessionId: string) => void): (() => void) =>
    subscribe(IPC.evIntegrationUnconfirmed, cb),
  onInteractiveProgram: (
    cb: (sessionId: string, program: InteractiveProgramName) => void
  ): (() => void) => subscribe(IPC.evInteractiveProgram, cb),
  onDashboard: (cb: (sessionId: string, metrics: DashboardMetrics) => void): (() => void) =>
    subscribe(IPC.evDashboard, cb),
  onDashboardAlert: (cb: (sessionId: string, alert: DashboardAlert) => void): (() => void) =>
    subscribe(IPC.evDashboardAlert, cb),
  onError: (cb: (sessionId: string, explanation: ErrorExplanation) => void): (() => void) =>
    subscribe(IPC.evError, cb),

  // --- Каталог команд ---
  getCommandCatalog: (): Promise<CommandsDatabase> => ipcRenderer.invoke(IPC.catalogGet),

  // --- Автообновление (UPD-01…04) ---
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke(IPC.updateCheck),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.updateDownload),
  installUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.updateInstall),
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.updateGetStatus),
  onUpdateStatus: (cb: (status: UpdateStatus) => void): (() => void) =>
    subscribe(IPC.evUpdateStatus, cb),

  // --- История команд ---
  listHistory: (query?: HistoryQuery): Promise<HistoryEntry[]> =>
    ipcRenderer.invoke(IPC.historyList, query),
  historyCount: (): Promise<number> => ipcRenderer.invoke(IPC.historyCount),
  addHistoryNote: (id: number, note: string): Promise<void> =>
    ipcRenderer.invoke(IPC.historyAddNote, id, note),
  deleteHistoryEntry: (id: number): Promise<void> => ipcRenderer.invoke(IPC.historyDelete, id),
  clearHistory: (): Promise<void> => ipcRenderer.invoke(IPC.historyClear),

  // --- Сниппеты / избранное ---
  listSnippets: (hostId?: number): Promise<Snippet[]> =>
    ipcRenderer.invoke(IPC.snippetsList, hostId),
  createSnippet: (input: {
    name: string;
    command: string;
    description?: string;
    hostId?: number;
  }): Promise<{ id: number }> => ipcRenderer.invoke(IPC.snippetCreate, input),
  updateSnippet: (
    id: number,
    // hostId: undefined — не трогать, null — явно сделать глобальным (SNIP-05)
    input: { name?: string; command?: string; description?: string; hostId?: number | null }
  ): Promise<void> => ipcRenderer.invoke(IPC.snippetUpdate, id, input),
  deleteSnippet: (id: number): Promise<void> => ipcRenderer.invoke(IPC.snippetDelete, id),
  resolveHostSnippets: (hostId: number, action: 'delete' | 'make-global'): Promise<void> =>
    ipcRenderer.invoke(IPC.snippetResolveHost, hostId, action),
  hostHasSnippets: (hostId: number): Promise<boolean> =>
    ipcRenderer.invoke(IPC.snippetHostHas, hostId),
  reorderSnippets: (orderedIds: number[]): Promise<void> =>
    ipcRenderer.invoke(IPC.snippetsReorder, orderedIds),
  findDuplicateSnippet: (
    command: string,
    hostId?: number,
    excludeId?: number
  ): Promise<Snippet | null> =>
    ipcRenderer.invoke(IPC.snippetFindDuplicate, command, hostId, excludeId),

  // --- Onboarding (OB-01…03) ---
  puttySessionsCount: (): Promise<number> => ipcRenderer.invoke(IPC.puttySessionsCount),

  // --- Окно (кастомный тайтл-бар) ---
  windowMinimize: (): void => ipcRenderer.send(IPC.windowMinimize),
  windowToggleMaximize: (): void => ipcRenderer.send(IPC.windowToggleMaximize),
  windowClose: (): void => ipcRenderer.send(IPC.windowClose),
  windowConfirmClose: (): void => ipcRenderer.send(IPC.windowConfirmClose),
  // Две подписки ниже не отдают полезную нагрузку колбэку как есть: контракт
  // описывает то, что кладёт emit, а не то, что дошло — нормализация остаётся.
  onConfirmWindowClose: (
    cb: (activeCount: number, busySessions: Array<{ hostName: string; command: string }>) => void
  ): (() => void) =>
    subscribe(IPC.evConfirmWindowClose, (activeCount, busySessions) => {
      cb(activeCount, Array.isArray(busySessions) ? busySessions : []);
    }),
  onWindowMaximized: (cb: (maximized: boolean) => void): (() => void) =>
    subscribe(IPC.evWindowMaximized, (maximized) => {
      cb(maximized === true);
    })
} as const;

export type LucidSSHBridge = typeof api;

contextBridge.exposeInMainWorld('lucidSSH', api);
