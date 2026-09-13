import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { AppConfig } from '@shared/config';
import { DEFAULT_HOTKEYS } from '@shared/hotkeys';
import type { Host } from '@shared/hosts';
import type { Snippet } from '@shared/history';
import { IPC } from '@shared/ipc';

/**
 * Стенд каналов IPC (spec.md, `.scratch/ipc-boundary-invariants/`, ADR-0018).
 *
 * Регистрирует все 85 хендлеров Запрос/ответ через мок `ipcMain` и бьёт в них
 * по имени канала из `IPC`, с фальшивым `event` и сырыми `unknown`-аргументами —
 * как renderer. Хендлеры НЕ рефакторятся в именованные экспорты: шов теста —
 * канал, а не функция (см. «Решения», п.2 spec.md) — иначе тест проверял бы,
 * что проверка верна, а не что хендлер её вызывает.
 *
 * На стенде — параметрический тест сторожа отправителя по всем каналам без
 * списка исключений (п.1) и точечные тесты инвариантов границы 3–7. Инвариант
 * 2 (Страж) — предмет PR-2, здесь не проверяется.
 *
 * Одна тестовая программа: `vi.mock` поднимается только в файле, где написан,
 * поэтому весь стенд и все случаи — здесь, а не в общем хелпере.
 */

// --- Стенд: регистр хендлеров и путь к репозиторию (нужны внутри vi.mock,
// поэтому объявлены через vi.hoisted — обычные top-level const в фабрику не
// протекают). ---
const stand = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  repoRoot: ''
}));
// localesDir() (i18n, не мокается) резолвится от app.getAppPath() — используем
// настоящий корень репозитория, чтобы пункт 7 проверял NS_RE/LANG_RE и
// существование файлов на настоящих assets/locales, а не на моке.
stand.repoRoot = resolve(fileURLToPath(import.meta.url), '../../../..');

// --- electron: ipcMain складывает хендлеры в Map и бросает на повторной
// регистрации канала — как настоящий Electron (spec.md, «Границы»). ---
vi.mock('electron', () => {
  const register = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    if (stand.handlers.has(channel)) {
      throw new Error(`Duplicate ipcMain registration for channel "${channel}"`);
    }
    stand.handlers.set(channel, fn);
  };
  return {
    ipcMain: {
      handle: vi.fn(register),
      on: vi.fn(register)
    },
    app: {
      getVersion: vi.fn(() => '0.0.0-test'),
      getAppPath: vi.fn(() => stand.repoRoot),
      isPackaged: false
    },
    shell: { openExternal: vi.fn() },
    dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
    clipboard: { readText: vi.fn(), writeText: vi.fn() }
  };
});

vi.mock('../window/mainWindow', () => ({
  getMainWindow: vi.fn(),
  forceCloseWindow: vi.fn()
}));

// --- Делегаты — явными фабриками (spec.md, решение 3): keytar грузит нативный
// бинарь при require, автомок без фабрики импортировал бы оригинал. С
// фабриками нативные модули не грузятся вовсе — rebuild:test не нужен. ---

const configFixture = vi.hoisted(() => ({ cfg: undefined as unknown as AppConfig }));

vi.mock('../config/store', () => {
  const saveConfig = vi.fn();
  const loadConfig = vi.fn(() => configFixture.cfg);
  // Инвариант 5 (spec.md, «Границы — приняты намеренно») опирается на этот
  // порядок: мутатор над фикстурой → saveConfig(). Сеттер, бросивший на
  // диапазоне/типе, не доходит до записи. Если store.ts:51-56 поменяет
  // порядок — эту фабрику нужно поправить вместе с ним.
  const updateConfig = vi.fn((mutator: (cfg: AppConfig) => void) => {
    mutator(configFixture.cfg);
    saveConfig();
    return configFixture.cfg;
  });
  const resetConfig = vi.fn(() => configFixture.cfg);
  return { loadConfig, updateConfig, saveConfig, resetConfig };
});

vi.mock('../content/loader', () => ({
  loadCommandCatalog: vi.fn()
}));

vi.mock('../guard/manager', () => ({
  submitCommand: vi.fn(),
  submitRawInput: vi.fn(),
  confirmDangerousCommand: vi.fn(),
  cancelDangerousCommand: vi.fn()
}));

vi.mock('../history/repository', () => ({
  addHistoryNote: vi.fn(),
  clearHistory: vi.fn(),
  clearHistoryForHost: vi.fn(),
  deleteHistoryEntry: vi.fn(),
  historyCountForHost: vi.fn(),
  listHistory: vi.fn(),
  totalHistoryCount: vi.fn()
}));

vi.mock('../history/snippets', () => ({
  createSnippet: vi.fn(),
  deleteSnippet: vi.fn(),
  findDuplicateSnippet: vi.fn(),
  getSnippet: vi.fn(),
  hostHasSnippets: vi.fn(),
  listSnippets: vi.fn(),
  reorderSnippets: vi.fn(),
  resolveHostSnippets: vi.fn(),
  updateSnippet: vi.fn()
}));

vi.mock('../hosts/dashboardMutes', () => ({
  addDismissedAlert: vi.fn(),
  listDismissedAlerts: vi.fn(),
  replaceDismissedAlerts: vi.fn()
}));

vi.mock('../hosts/exportImport', () => ({
  buildExport: vi.fn(),
  // instanceof в hosts.ts (catch-блоки hostsImportPick/hostsImportApply) —
  // настоящий класс, а не vi.fn (тикет 01, «Стенд»).
  ImportFormatError: class ImportFormatError extends Error {},
  importHosts: vi.fn(),
  previewImport: vi.fn()
}));

vi.mock('../hosts/externalImport', () => ({
  applyExternalImport: vi.fn()
}));

vi.mock('../hosts/keyFile', () => ({
  keyFileExists: vi.fn()
}));

vi.mock('../hosts/puttyDetect', () => ({
  countPuttySessions: vi.fn()
}));

vi.mock('../hosts/puttyImport', () => ({
  importPuttyPreview: vi.fn()
}));

vi.mock('../hosts/sshConfigImport', () => ({
  importSshConfigPreview: vi.fn()
}));

vi.mock('../hosts/winscpImport', () => ({
  importWinScpRegistryPreview: vi.fn(),
  importWinScpIniPreview: vi.fn()
}));

vi.mock('../keychain', () => ({
  setSecret: vi.fn(),
  getSecretForConnection: vi.fn(),
  hasSecret: vi.fn(),
  deleteSecret: vi.fn()
}));

vi.mock('../ssh/hostKeyDecision', () => ({
  applyHostKeyDecision: vi.fn()
}));

vi.mock('../ssh/keygen', () => ({
  applyPassphrase: vi.fn(),
  clearPendingDeployment: vi.fn(),
  findSshKeygen: vi.fn(),
  generateKeyPair: vi.fn()
}));

vi.mock('../ssh/knownHosts', () => ({
  listKnownHosts: vi.fn(),
  parseHostToken: vi.fn(),
  removeKnownHostLine: vi.fn(),
  sha256Fingerprint: vi.fn()
}));

vi.mock('../ssh/sessionManager', () => ({
  answerAuthPrompt: vi.fn(),
  connectHost: vi.fn(),
  connectQuickHost: vi.fn(),
  destroySession: vi.fn(),
  disconnectSession: vi.fn(),
  getSessionLog: vi.fn(),
  listSessions: vi.fn(),
  resizeSession: vi.fn(),
  sessionExists: vi.fn()
}));

vi.mock('../ssh/testConnection', () => ({
  testConnection: vi.fn()
}));

vi.mock('../updates/updater', () => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  getStatus: vi.fn(),
  installUpdate: vi.fn()
}));

vi.mock('../hosts/repository', () => ({
  listHosts: vi.fn(),
  getHost: vi.fn(),
  createHost: vi.fn(),
  updateHost: vi.fn(),
  deleteHost: vi.fn(),
  reorderHosts: vi.fn(),
  findHostByAddressPort: vi.fn(),
  hostExists: vi.fn(),
  setProxyJumpHostId: vi.fn(),
  checkJumpHost: vi.fn(),
  listHostsReferencingProxyJump: vi.fn(),
  hostNameExists: vi.fn(),
  listGroups: vi.fn(),
  createGroup: vi.fn(),
  renameGroup: vi.fn(),
  setGroupCollapsed: vi.fn(),
  deleteGroup: vi.fn(),
  groupExists: vi.fn()
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn()
}));

// Не мокаются (spec.md, «Границы»): '../hosts/validate' (чистые валидаторы),
// './validate' (сторож — предмет теста), '../i18n' (пункт 7 проверяет
// настоящие NS_RE/LANG_RE, не мок), '@shared/*'.

// --- Импорты после моков ---
import * as electron from 'electron';
import * as mainWindowModule from '../window/mainWindow';
import * as configStoreModule from '../config/store';
import * as contentLoaderModule from '../content/loader';
import * as guardManagerModule from '../guard/manager';
import * as historyRepositoryModule from '../history/repository';
import * as historySnippetsModule from '../history/snippets';
import * as dashboardMutesModule from '../hosts/dashboardMutes';
import * as exportImportModule from '../hosts/exportImport';
import * as externalImportModule from '../hosts/externalImport';
import * as keyFileModule from '../hosts/keyFile';
import * as puttyDetectModule from '../hosts/puttyDetect';
import * as puttyImportModule from '../hosts/puttyImport';
import * as sshConfigImportModule from '../hosts/sshConfigImport';
import * as winscpImportModule from '../hosts/winscpImport';
import * as keychainModule from '../keychain';
import * as hostKeyDecisionModule from '../ssh/hostKeyDecision';
import * as keygenModule from '../ssh/keygen';
import * as knownHostsModule from '../ssh/knownHosts';
import * as sessionManagerModule from '../ssh/sessionManager';
import * as testConnectionModule from '../ssh/testConnection';
import * as updaterModule from '../updates/updater';
import * as hostsRepositoryModule from '../hosts/repository';
import * as fsPromisesModule from 'node:fs/promises';

import { IpcValidationError } from './validate';
import { registerIpcHandlers } from './index';
import { registerHostIpcHandlers } from './hosts';
import { registerSessionIpcHandlers } from './sessions';
import { registerConfigIpcHandlers } from './config';
import { registerContentIpcHandlers } from './content';
import { registerHistoryIpcHandlers } from './history';
import { registerSecurityIpcHandlers } from './security';
import { registerUpdateIpcHandlers } from './updates';

// --- Регистрация — один раз, при инициализации модуля теста (не в beforeAll):
// it.each ниже читает список каналов на этапе сбора тестов, до первого
// beforeAll/beforeEach. Ровно как src/main/index.ts:43-50. ---
registerIpcHandlers();
registerHostIpcHandlers();
registerSessionIpcHandlers();
registerConfigIpcHandlers();
registerContentIpcHandlers();
registerHistoryIpcHandlers();
registerSecurityIpcHandlers();
registerUpdateIpcHandlers();

const NON_EVENT_CHANNELS: string[] = Object.values(IPC).filter(
  (channel) => !channel.startsWith('ev:')
);

// --- Фальшивое главное окно (образец — events.test.ts) ---
const mainFrame: object = {};
const mainWebContents = { mainFrame, send: vi.fn() };
const fakeMainWindow = {
  webContents: mainWebContents,
  minimize: vi.fn(),
  maximize: vi.fn(),
  unmaximize: vi.fn(),
  isMaximized: vi.fn(() => false),
  close: vi.fn()
};

const mockGetMainWindow = vi.mocked(mainWindowModule.getMainWindow);

function mainEvent(): IpcMainInvokeEvent {
  return { sender: mainWebContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
}
function foreignEvent(): IpcMainInvokeEvent {
  return { sender: {}, senderFrame: {} } as unknown as IpcMainInvokeEvent;
}
function subframeEvent(): IpcMainInvokeEvent {
  return { sender: mainWebContents, senderFrame: {} } as unknown as IpcMainInvokeEvent;
}

/** Зовёт хендлер по имени канала — как renderer через preload. Нормализует
 *  синхронный throw и rejected promise (хендлеры бывают async) в одну форму. */
async function invoke(
  channel: string,
  event: IpcMainInvokeEvent,
  ...args: unknown[]
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  const handler = stand.handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for channel "${channel}"`);
  try {
    const value = await handler(event, ...args);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Перебирает экспорты замоканного модуля (и на глубину 1 — вложенные объекты
 *  вроде electron.ipcMain/app/shell/dialog/clipboard), собирая vi.fn-шпионы.
 *  Программно — иначе новый делегат выпадет из проверки «ни один не вызван»
 *  молча (тикет 01, пункт 1). */
function collectMockFns(value: unknown, depth: number, out: unknown[]): void {
  if (vi.isMockFunction(value)) {
    out.push(value);
    return;
  }
  if (depth > 0 && typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) collectMockFns(v, depth - 1, out);
  }
}

const MOCKED_MODULES: unknown[] = [
  electron,
  mainWindowModule,
  configStoreModule,
  contentLoaderModule,
  guardManagerModule,
  historyRepositoryModule,
  historySnippetsModule,
  dashboardMutesModule,
  exportImportModule,
  externalImportModule,
  keyFileModule,
  puttyDetectModule,
  puttyImportModule,
  sshConfigImportModule,
  winscpImportModule,
  keychainModule,
  hostKeyDecisionModule,
  keygenModule,
  knownHostsModule,
  sessionManagerModule,
  testConnectionModule,
  updaterModule,
  hostsRepositoryModule,
  fsPromisesModule
];

/** Все шпионы делегатов/electron/fs, КРОМЕ getMainWindow — тот считается отдельно
 *  (сторож обязан позвать его ровно один раз, чтобы решить, что сторонний
 *  отправитель отклонён). */
function delegateSpies(): unknown[] {
  const out: unknown[] = [];
  for (const mod of MOCKED_MODULES) collectMockFns(mod, 1, out);
  return out.filter((fn) => fn !== mockGetMainWindow);
}

function createConfigFixture(): AppConfig {
  return {
    version: '0.0.0-test',
    language: 'ru',
    window: { width: 1280, height: 800, maximized: false },
    pendingKeyDeployments: [],
    ui: {
      expertMode: false,
      hints: {
        commandCatalog: true,
        outputTooltips: true,
        errorPanel: true,
        connectionDialog: true
      },
      theme: 'dark',
      notifications: { systemToasts: true, longCommandThresholdSec: 30 },
      dashboardVisible: true,
      catalogPanelOpen: true,
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
    connection: { autoreconnect: true, keepaliveIntervalSec: 30, connectTimeoutSec: 15 },
    guard: { globalEnabled: true },
    hotkeys: { ...DEFAULT_HOTKEYS },
    history: { enabled: true },
    shownCounts: {},
    updates: { autoCheck: true, source: '' }
  };
}

function fakeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: 1,
    name: 'srv1',
    address: '10.0.0.1',
    port: 22,
    username: 'root',
    authMethod: 'password',
    guardEnabled: true,
    historyEnabled: true,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function fakeSnippet(overrides: Partial<Snippet> = {}): Snippet {
  return {
    id: 1,
    name: 'snip',
    command: 'ls',
    danger: false,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function validHostInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'srv1',
    address: '10.0.0.1',
    port: 22,
    username: 'root',
    authMethod: 'password',
    guardEnabled: true,
    historyEnabled: true,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMainWindow.mockReturnValue(fakeMainWindow as unknown as BrowserWindow);
  configFixture.cfg = createConfigFixture();
});

describe('регистрация каналов', () => {
  it('множество каналов IPC без префикса ev: совпадает с множеством зарегистрированных — в обе стороны', () => {
    expect(new Set(stand.handlers.keys())).toEqual(new Set(NON_EVENT_CHANNELS));
    expect(stand.handlers.size).toBe(NON_EVENT_CHANNELS.length);
  });
});

describe('пункт 1 — сторож отправителя (параметрический тест по всем 85 каналам)', () => {
  // Без списка исключений (spec.md, решение 4): новый канал попадает под
  // проверку без правки теста.
  it.each(NON_EVENT_CHANNELS)(
    '%s: чужой sender — IpcValidationError, ни один делегат не вызван',
    async (channel) => {
      const result = await invoke(channel, foreignEvent());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(IpcValidationError);
      expect((result.error as IpcValidationError).message).toBe('IPC from unknown sender rejected');

      expect(mockGetMainWindow).toHaveBeenCalledTimes(1);
      for (const spy of delegateSpies()) {
        expect(spy).not.toHaveBeenCalled();
      }
    }
  );

  describe('hosts:list — обе ветки отказа + контроль легитимного вызова', () => {
    it('subframe — IPC from subframe rejected', async () => {
      const result = await invoke(IPC.hostsList, subframeEvent());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(IpcValidationError);
      expect((result.error as IpcValidationError).message).toBe('IPC from subframe rejected');
    });

    it('окна нет (getMainWindow → null) — IPC from unknown sender rejected', async () => {
      mockGetMainWindow.mockReturnValue(null);
      const result = await invoke(IPC.hostsList, mainEvent());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(IpcValidationError);
      expect((result.error as IpcValidationError).message).toBe('IPC from unknown sender rejected');
    });

    it('mainEvent — делегат вызван (стенд пропускает легитимный вызов)', async () => {
      const mockListHosts = vi.mocked(hostsRepositoryModule.listHosts);
      mockListHosts.mockReturnValue([]);
      const result = await invoke(IPC.hostsList, mainEvent());
      expect(result).toEqual({ ok: true, value: [] });
      expect(mockListHosts).toHaveBeenCalledTimes(1);
    });
  });

  // Проверка, что параметрический тест выше реально ловит регрессию: сторож,
  // переставленный ПОСЛЕ делегата, линтер ADR-0011 пропускает (spec.md,
  // «Дыра правила ESLint»), а этот тест должен покраснеть.
  //
  // Проверено вручную (не в CI): в src/main/ipc/hosts.ts, hostDelete, порядок
  // временно менялся на
  //   const id = validateId(rawId, 'hostId');
  //   assertSenderIsMainWindow(event);
  // — кейс `hosts:delete` из it.each выше падал с сообщением об ошибке
  // валидатора id на undefined вместо «IPC from unknown sender rejected» (и
  // repo.getHost/deleteHost получали вызов до отказа). Правка возвращена.
});

describe('пункт 3 — hostDelete без force не удаляет', () => {
  const mockListDependents = vi.mocked(hostsRepositoryModule.listHostsReferencingProxyJump);
  const mockGetHost = vi.mocked(hostsRepositoryModule.getHost);
  const mockDeleteHost = vi.mocked(hostsRepositoryModule.deleteHost);
  const mockDeleteSecret = vi.mocked(keychainModule.deleteSecret);
  const mockClearPendingDeployment = vi.mocked(keygenModule.clearPendingDeployment);

  beforeEach(() => {
    mockGetHost.mockReturnValue(fakeHost());
  });

  it.each([undefined, 'true', 1, {}])(
    'зависимые хосты есть, force=%p (не литерал true) — не удаляет, возвращает dependents',
    async (rawForce) => {
      const dependent = fakeHost({ id: 2, name: 'dependent' });
      mockListDependents.mockReturnValue([dependent]);

      const result = await invoke(IPC.hostDelete, mainEvent(), 1, rawForce);

      expect(result).toEqual({ ok: true, value: { deleted: false, dependents: [dependent] } });
      expect(mockDeleteHost).not.toHaveBeenCalled();
      expect(mockDeleteSecret).not.toHaveBeenCalled();
      expect(mockClearPendingDeployment).not.toHaveBeenCalled();
    }
  );

  it('force===true при зависимых — удаляет (контроль)', async () => {
    mockListDependents.mockReturnValue([fakeHost({ id: 2 })]);

    const result = await invoke(IPC.hostDelete, mainEvent(), 1, true);

    expect(result).toEqual({ ok: true, value: { deleted: true } });
    expect(mockDeleteHost).toHaveBeenCalledWith(1);
    expect(mockDeleteSecret).toHaveBeenCalledWith(1);
  });
});

describe('пункт 4 — сортировка только в пределах одной группы/скоупа', () => {
  describe('hosts:reorder', () => {
    const mockGetHost = vi.mocked(hostsRepositoryModule.getHost);
    const mockReorderHosts = vi.mocked(hostsRepositoryModule.reorderHosts);

    it('id из разных групп (включая null против числа) — отказ, reorderHosts не вызван', async () => {
      mockGetHost.mockImplementation((id: number) =>
        id === 1 ? fakeHost({ id: 1, groupId: undefined }) : fakeHost({ id: 2, groupId: 5 })
      );

      const result = await invoke(IPC.hostsReorder, mainEvent(), [1, 2]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(IpcValidationError);
      expect(mockReorderHosts).not.toHaveBeenCalled();
    });

    it('один id не найден — отказ, reorderHosts не вызван', async () => {
      mockGetHost.mockImplementation((id: number) => (id === 1 ? fakeHost({ id: 1 }) : null));

      const result = await invoke(IPC.hostsReorder, mainEvent(), [1, 2]);

      expect(result.ok).toBe(false);
      expect(mockReorderHosts).not.toHaveBeenCalled();
    });

    it('одна группа — reorderHosts вызван с id в переданном порядке (контроль)', async () => {
      mockGetHost.mockImplementation((id: number) => fakeHost({ id, groupId: 5 }));

      const result = await invoke(IPC.hostsReorder, mainEvent(), [2, 1]);

      expect(result).toEqual({ ok: true, value: undefined });
      expect(mockReorderHosts).toHaveBeenCalledWith([2, 1]);
    });
  });

  describe('snippets:reorder', () => {
    const mockGetSnippet = vi.mocked(historySnippetsModule.getSnippet);
    const mockReorderSnippets = vi.mocked(historySnippetsModule.reorderSnippets);

    it('сниппеты с hostId null и 5 — отказ, reorderSnippets не вызван', async () => {
      mockGetSnippet.mockImplementation((id: number) =>
        id === 1 ? fakeSnippet({ id: 1, hostId: undefined }) : fakeSnippet({ id: 2, hostId: 5 })
      );

      const result = await invoke(IPC.snippetsReorder, mainEvent(), [1, 2]);

      expect(result.ok).toBe(false);
      expect(mockReorderSnippets).not.toHaveBeenCalled();
    });

    it('несуществующий id — отказ, reorderSnippets не вызван', async () => {
      mockGetSnippet.mockImplementation((id: number) => (id === 1 ? fakeSnippet({ id: 1 }) : null));

      const result = await invoke(IPC.snippetsReorder, mainEvent(), [1, 2]);

      expect(result.ok).toBe(false);
      expect(mockReorderSnippets).not.toHaveBeenCalled();
    });

    it('один скоуп (hostId=5) — reorderSnippets вызван с id в переданном порядке (контроль)', async () => {
      mockGetSnippet.mockImplementation((id: number) => fakeSnippet({ id, hostId: 5 }));

      const result = await invoke(IPC.snippetsReorder, mainEvent(), [2, 1]);

      expect(result).toEqual({ ok: true, value: undefined });
      expect(mockReorderSnippets).toHaveBeenCalledWith([2, 1]);
    });
  });
});

describe('пункт 5 — allow-list configUpdate', () => {
  const mockSaveConfig = vi.mocked(configStoreModule.saveConfig);

  it.each(['foo', 'language', 'pendingKeyDeployments', 42, null])(
    'путь %p — не в allow-list, отказ, saveConfig не вызван',
    async (rawPath) => {
      const result = await invoke(IPC.configUpdate, mainEvent(), rawPath, 14);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(IpcValidationError);
      expect((result.error as IpcValidationError).message).toBe('path: unknown setting');
      expect(mockSaveConfig).not.toHaveBeenCalled();
    }
  );

  // Живой дефект (spec.md): `rawPath in WRITABLE` смотрит цепочку прототипа.
  // До fix (config.ts:82, `in` → `Object.hasOwn`) эти четыре ключа наследуются
  // от Object.prototype как ФУНКЦИИ — allow-list их пропускает, сеттер
  // вызывается как WRITABLE[key](value, cfg) (т.е. Object.prototype.toString и
  // т.п. с левым this), ничего не мутирует, не бросает — и updateConfig всё
  // равно доходит до saveConfig(). Эти четыре кейса КРАСНЫЕ до fix.
  it.each(['toString', 'constructor', 'hasOwnProperty', 'valueOf'])(
    'ключ прототипа %p — отказ IpcValidationError, saveConfig не вызван (красный до fix)',
    async (rawPath) => {
      const result = await invoke(IPC.configUpdate, mainEvent(), rawPath, 14);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(IpcValidationError);
      expect((result.error as IpcValidationError).message).toBe('path: unknown setting');
      expect(mockSaveConfig).not.toHaveBeenCalled();
    }
  );

  // `__proto__` — не собственное свойство и не функция: тот же WRITABLE[key]
  // возвращает Object.prototype, вызов `setter(...)` бросает TypeError ДО
  // saveConfig(). До fix — некатегоризированная ошибка, не IpcValidationError:
  // тоже красный кейс.
  it('__proto__ — отказ IpcValidationError, saveConfig не вызван (красный до fix)', async () => {
    const result = await invoke(IPC.configUpdate, mainEvent(), '__proto__', 14);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IpcValidationError);
    expect((result.error as IpcValidationError).message).toBe('path: unknown setting');
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  it('значение вне диапазона (terminal.fontSize=100) — отказ, saveConfig не вызван', async () => {
    const result = await invoke(IPC.configUpdate, mainEvent(), 'terminal.fontSize', 100);
    expect(result.ok).toBe(false);
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  it('значение не того типа (ui.expertMode="yes") — отказ, saveConfig не вызван', async () => {
    const result = await invoke(IPC.configUpdate, mainEvent(), 'ui.expertMode', 'yes');
    expect(result.ok).toBe(false);
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  it('valid path/value (terminal.fontSize=14) — saveConfig вызван, ответ содержит новое значение (контроль)', async () => {
    const result = await invoke(IPC.configUpdate, mainEvent(), 'terminal.fontSize', 14);

    expect(mockSaveConfig).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as { terminal: { fontSize: number } }).terminal.fontSize).toBe(14);
  });
});

describe('пункт 6 — hostCreate/hostUpdate не пишут при отказе', () => {
  const mockGroupExists = vi.mocked(hostsRepositoryModule.groupExists);
  const mockCheckJumpHost = vi.mocked(hostsRepositoryModule.checkJumpHost);
  const mockGetHost = vi.mocked(hostsRepositoryModule.getHost);
  const mockCreateHost = vi.mocked(hostsRepositoryModule.createHost);
  const mockUpdateHost = vi.mocked(hostsRepositoryModule.updateHost);
  const mockSetSecret = vi.mocked(keychainModule.setSecret);

  describe('hosts:create', () => {
    it('groupId несуществующей группы — отказ, createHost/setSecret не вызваны', async () => {
      mockGroupExists.mockReturnValue(false);

      const result = await invoke(
        IPC.hostCreate,
        mainEvent(),
        validHostInput({ groupId: 5 }),
        'secret'
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(IpcValidationError);
      expect((result.error as IpcValidationError).message).toBe('groupId: group not found');
      expect(mockCreateHost).not.toHaveBeenCalled();
      expect(mockSetSecret).not.toHaveBeenCalled();
    });

    it('proxyJumpHostId — checkJumpHost отклоняет — IpcValidationError, createHost/setSecret не вызваны', async () => {
      mockCheckJumpHost.mockReturnValue('self');

      const result = await invoke(
        IPC.hostCreate,
        mainEvent(),
        validHostInput({ proxyJumpHostId: 3 }),
        undefined
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(IpcValidationError);
      expect((result.error as IpcValidationError).message).toBe('proxyJumpHostId: self');
      expect(mockCreateHost).not.toHaveBeenCalled();
      expect(mockSetSecret).not.toHaveBeenCalled();
    });

    it('валидный ввод с секретом — createHost, затем setSecret(id, secret) (контроль)', async () => {
      mockCreateHost.mockReturnValue(42);

      const result = await invoke(IPC.hostCreate, mainEvent(), validHostInput(), 's3cr3t');

      expect(result).toEqual({ ok: true, value: { id: 42 } });
      expect(mockCreateHost).toHaveBeenCalledTimes(1);
      expect(mockSetSecret).toHaveBeenCalledWith(42, 's3cr3t');
    });
  });

  describe('hosts:update', () => {
    it('хост не найден — отказ, updateHost/setSecret не вызваны', async () => {
      mockGetHost.mockReturnValue(null);

      const result = await invoke(IPC.hostUpdate, mainEvent(), 1, validHostInput(), undefined);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as IpcValidationError).message).toBe('hostId: not found');
      expect(mockUpdateHost).not.toHaveBeenCalled();
      expect(mockSetSecret).not.toHaveBeenCalled();
    });

    it('groupId несуществующей группы — отказ, updateHost/setSecret не вызваны', async () => {
      mockGetHost.mockReturnValue(fakeHost({ id: 1 }));
      mockGroupExists.mockReturnValue(false);

      const result = await invoke(
        IPC.hostUpdate,
        mainEvent(),
        1,
        validHostInput({ groupId: 5 }),
        undefined
      );

      expect(result.ok).toBe(false);
      expect(mockUpdateHost).not.toHaveBeenCalled();
      expect(mockSetSecret).not.toHaveBeenCalled();
    });

    it('checkJumpHost отклоняет — IpcValidationError, checkJumpHost получил id хоста вторым аргументом, updateHost/setSecret не вызваны', async () => {
      mockGetHost.mockReturnValue(fakeHost({ id: 7 }));
      mockCheckJumpHost.mockReturnValue('chain');

      const result = await invoke(
        IPC.hostUpdate,
        mainEvent(),
        7,
        validHostInput({ proxyJumpHostId: 3 }),
        undefined
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as IpcValidationError).message).toBe('proxyJumpHostId: chain');
      expect(mockCheckJumpHost).toHaveBeenCalledWith(3, 7);
      expect(mockUpdateHost).not.toHaveBeenCalled();
      expect(mockSetSecret).not.toHaveBeenCalled();
    });

    it('валидный ввод с секретом — updateHost, затем setSecret(id, secret) (контроль)', async () => {
      mockGetHost.mockReturnValue(fakeHost({ id: 7 }));

      const result = await invoke(IPC.hostUpdate, mainEvent(), 7, validHostInput(), 's3cr3t');

      expect(result).toEqual({ ok: true, value: undefined });
      expect(mockUpdateHost).toHaveBeenCalledTimes(1);
      expect(mockSetSecret).toHaveBeenCalledWith(7, 's3cr3t');
    });
  });
});

describe('пункт 7 — i18nGetResource: путь только из провалидированных сегментов', () => {
  const mockReadFile = vi.mocked(fsPromisesModule.readFile);

  it.each(['../..', 'ru/../en', 'RU', 'r'])(
    'язык %p — отказ, readFile не вызван',
    async (lang) => {
      const result = await invoke(IPC.i18nGetResource, mainEvent(), lang, 'common');
      expect(result.ok).toBe(false);
      expect(mockReadFile).not.toHaveBeenCalled();
    }
  );

  it.each(['../config', 'common/../../x', 'a\\b', 'Common', 'nope'])(
    'namespace %p — отказ, readFile не вызван',
    async (ns) => {
      const result = await invoke(IPC.i18nGetResource, mainEvent(), 'ru', ns);
      expect(result.ok).toBe(false);
      expect(mockReadFile).not.toHaveBeenCalled();
    }
  );

  it('ru/common — readFile вызван один раз с путём внутри assets/locales/ru/ (контроль)', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ hello: 'world' }));

    const result = await invoke(IPC.i18nGetResource, mainEvent(), 'ru', 'common');

    expect(result).toEqual({ ok: true, value: { hello: 'world' } });
    expect(mockReadFile).toHaveBeenCalledTimes(1);
    const calledPath = mockReadFile.mock.calls[0]?.[0] as string;
    // path.relative, не сравнение строк целиком — разделители Windows/POSIX.
    expect(relative(join(stand.repoRoot, 'assets', 'locales', 'ru'), calledPath)).toBe('common.json');
  });
});
