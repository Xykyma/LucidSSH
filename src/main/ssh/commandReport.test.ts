import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@shared/config';
import type { Host } from '@shared/hosts';
import type { ErrorExplanation } from '@shared/content';

// commandReport.ts несёт 9 из 13 моков sessionManager.ts (issue 02 спеки,
// .scratch/shell-channel-extraction/spec.md «Solution» / commandReport.ts) —
// ровно та композиция, которая раньше не имела ни одного теста.
vi.mock('../hosts/repository', () => ({ getHost: vi.fn() }));
vi.mock('../config/store', () => ({ loadConfig: vi.fn() }));
vi.mock('../window/mainWindow', () => ({ getMainWindow: vi.fn(() => null) }));
vi.mock('../content/loader', () => ({
  loadErrorPatterns: vi.fn(() => []),
  loadCommandCatalog: vi.fn(() => ({ version: '1', categories: [], categoryLabels: {}, commands: [] }))
}));
vi.mock('../errors/detector', () => ({
  detectError: vi.fn(() => ({ matched: false, fallback: 'doc-search' })),
  excerpt: vi.fn((text: string) => text),
  isEmptyOutput: vi.fn(() => false),
  isNonErrorExitCode: vi.fn(() => false)
}));
vi.mock('../secrets/maskers', () => ({
  maskSecrets: vi.fn((s: string) => ({ masked: s, hasSecret: false }))
}));
vi.mock('../errors/fuzzyMatch', () => ({
  extractCommandName: vi.fn((c: string) => c),
  findCommandSuggestions: vi.fn(() => [])
}));
vi.mock('../i18n', () => ({ t: vi.fn((key: string) => key) }));
vi.mock('../history/repository', () => ({ recordHistory: vi.fn() }));
vi.mock('../notifications/notifier', () => ({ notifyCommandDone: vi.fn() }));

import { IPC } from '@shared/ipc';
import { loadConfig } from '../config/store';
import { getHost } from '../hosts/repository';
import { getMainWindow } from '../window/mainWindow';
import { detectError, isNonErrorExitCode } from '../errors/detector';
import { maskSecrets } from '../secrets/maskers';
import { recordHistory } from '../history/repository';
import type { ShellIntegrationEvent } from './shellIntegrationSession';
import { checkShellUnavailable, handleCommandFinished, type SessionIdentity } from './commandReport';

const mockLoadConfig = vi.mocked(loadConfig);
const mockGetHost = vi.mocked(getHost);
const mockGetMainWindow = vi.mocked(getMainWindow);
const mockDetectError = vi.mocked(detectError);
const mockIsNonErrorExitCode = vi.mocked(isNonErrorExitCode);
const mockMaskSecrets = vi.mocked(maskSecrets);
const mockRecordHistory = vi.mocked(recordHistory);

/** Фальшивое главное окно — достаточно для send()/webContents.send. */
function fakeWindow(): { isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } } {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } };
}

/** Вызовы send() на конкретный IPC-канал — второй/третий аргументы после channel. */
function sendCallsFor(
  win: ReturnType<typeof fakeWindow>,
  channel: string
): unknown[][] {
  return win.webContents.send.mock.calls.filter(([ch]) => ch === channel).map((call) => call.slice(1));
}

const noMatch = { matched: false as const, fallback: { kind: 'doc-search' as const, command: 'x', stderrExcerpt: '' } };

const fakeConfig = (overrides: Partial<AppConfig> = {}): AppConfig =>
  ({
    version: '0.0.0',
    language: 'ru',
    ui: { hints: { errorPanel: true } },
    history: { enabled: true },
    ...overrides
  }) as unknown as AppConfig;

const fakeHost = (overrides: Partial<Host> = {}): Host => ({
  id: 1,
  name: 'web-01',
  address: '10.0.0.5',
  port: 22,
  username: 'nikita',
  authMethod: 'password',
  guardEnabled: true,
  historyEnabled: true,
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
  ...overrides
});

const fakeIdentity = (overrides: Partial<SessionIdentity> = {}): SessionIdentity => ({
  id: 's1',
  hostId: 1,
  hostName: 'web-01',
  ...overrides
});

type CommandFinishedEvent = Extract<ShellIntegrationEvent, { kind: 'command-finished' }>;

const fakeEvent = (overrides: Partial<CommandFinishedEvent> = {}): CommandFinishedEvent => ({
  kind: 'command-finished',
  command: 'ls -la',
  exitCode: 1,
  output: 'boom',
  typed: true,
  durationMs: 100,
  ...overrides
});

describe('commandReport — handleCommandFinished', () => {
  let win: ReturnType<typeof fakeWindow>;

  beforeEach(() => {
    vi.clearAllMocks();
    win = fakeWindow();
    mockLoadConfig.mockReturnValue(fakeConfig());
    mockGetHost.mockReturnValue(fakeHost());
    mockGetMainWindow.mockReturnValue(win as unknown as ReturnType<typeof getMainWindow>);
    mockDetectError.mockReturnValue(noMatch);
    mockIsNonErrorExitCode.mockReturnValue(false);
    mockMaskSecrets.mockImplementation((s: string) => ({ masked: s, hasSecret: false }));
  });

  it('прерывание сигналом при ненулевом коде возврата → детектор не зовётся', () => {
    handleCommandFinished(fakeIdentity(), fakeEvent({ exitCode: 130 })); // SIGINT (128+2)

    expect(mockDetectError).not.toHaveBeenCalled();
    expect(sendCallsFor(win, IPC.evError)).toHaveLength(0);
  });

  it('панель детектора выключена в «Интерфейсе» (SET-05) → не зовётся', () => {
    mockLoadConfig.mockReturnValue(fakeConfig({ ui: { hints: { errorPanel: false } } } as Partial<AppConfig>));

    handleCommandFinished(fakeIdentity(), fakeEvent());

    expect(mockDetectError).not.toHaveBeenCalled();
    expect(sendCallsFor(win, IPC.evError)).toHaveLength(0);
  });

  it('совпадения нет и код возврата признан штатным (issue 03) → не зовётся', () => {
    mockIsNonErrorExitCode.mockReturnValue(true);

    handleCommandFinished(fakeIdentity(), fakeEvent());

    expect(mockDetectError).toHaveBeenCalled(); // матч проверяется, совпадения нет
    expect(sendCallsFor(win, IPC.evError)).toHaveLength(0);
  });

  it('совпадения нет, обычный случай → уходит fallback-объяснение (ERR-06), команда и вывод в нём маскированы', () => {
    mockMaskSecrets.mockImplementation((s: string) => ({ masked: `MASKED(${s})`, hasSecret: true }));

    handleCommandFinished(fakeIdentity(), fakeEvent({ command: 'curl -u user:secret', output: 'boom' }));

    const calls = sendCallsFor(win, IPC.evError);
    expect(calls).toHaveLength(1);
    const [, explanation] = calls[0] as [string, ErrorExplanation];
    expect(explanation.source).toBe('fallback');
    expect(explanation.command).toBe('MASKED(curl -u user:secret)');
    expect(explanation.stderr).toBe('MASKED(boom)');
  });

  it('история выключена глобально → запись не производится (HIST-07)', () => {
    mockLoadConfig.mockReturnValue(fakeConfig({ history: { enabled: false } } as Partial<AppConfig>));

    handleCommandFinished(fakeIdentity(), fakeEvent({ exitCode: 0 }));

    expect(mockRecordHistory).not.toHaveBeenCalled();
  });

  it('история выключена для этого хоста (hosts.db, ADR-0015) → запись не производится (HIST-07)', () => {
    mockGetHost.mockReturnValue(fakeHost({ historyEnabled: false }));

    handleCommandFinished(fakeIdentity({ hostId: 1 }), fakeEvent({ exitCode: 0 }));

    expect(mockRecordHistory).not.toHaveBeenCalled();
  });

  it('Quick Connect (хост с нулевым идентификатором) → имя пользователя берётся из фоллбэка сессии, а не из репозитория хостов', () => {
    mockGetHost.mockReturnValue(null); // HM-11: getHost(0) всегда null

    handleCommandFinished(
      fakeIdentity({ hostId: 0, quickConnectUsername: 'quickuser' }),
      fakeEvent({ exitCode: 0 })
    );

    expect(mockRecordHistory).toHaveBeenCalledWith(expect.objectContaining({ username: 'quickuser' }));
  });
});

describe('commandReport — checkShellUnavailable', () => {
  let win: ReturnType<typeof fakeWindow>;

  beforeEach(() => {
    vi.clearAllMocks();
    win = fakeWindow();
    mockLoadConfig.mockReturnValue(fakeConfig());
    mockGetMainWindow.mockReturnValue(win as unknown as ReturnType<typeof getMainWindow>);
  });

  it('совпадение по scope ssh-connection → true и объяснение отправлено', () => {
    const explanation = { title: 't', explanation: 'e', checks: [], source: 'core' } as unknown as ErrorExplanation;
    mockDetectError.mockReturnValue({ matched: true, explanation });

    const result = checkShellUnavailable(fakeIdentity(), 'This account is currently not available.');

    expect(result).toBe(true);
    expect(sendCallsFor(win, IPC.evError)).toEqual([['s1', explanation]]);
  });

  it('совпадения нет → false, ничего не отправляется', () => {
    mockDetectError.mockReturnValue(noMatch);

    const result = checkShellUnavailable(fakeIdentity(), 'some banner');

    expect(result).toBe(false);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
