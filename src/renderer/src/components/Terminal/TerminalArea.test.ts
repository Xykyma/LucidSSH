import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { DashboardAlertIssue } from '@shared/dashboard';
import { DashboardHealthBanner } from './DashboardHealthBanner';
import { TerminalArea } from './TerminalArea';

const { dismissDashboardAlertIssue, ipcDismiss } = vi.hoisted(() => ({
  dismissDashboardAlertIssue: vi.fn(),
  ipcDismiss: vi.fn()
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => [
      typeof initial === 'function' ? initial() : initial,
      vi.fn()
    ],
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: vi.fn(),
    useCallback: (callback: unknown) => callback
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/sessions', () => ({
  useSessions: () => ({
    sessions: [{ sessionId: 'session-1', hostId: 42, hostName: 'server', status: 'connected' }],
    activeSessionId: 'session-1',
    reconnect: vi.fn(),
    closeTab: vi.fn(),
    sessionExtras: {
      'session-1': { dashboardAlert: { issues: ['cpu', 'rebootRequired'] } }
    },
    dismissError: vi.fn(),
    dismissDashboardAlertIssue,
    answerAuthPrompt: vi.fn()
  })
}));
vi.mock('@/stores/config', () => ({
  useConfig: () => ({
    config: {
      ui: { expertMode: true, catalogPanelOpen: false },
      shownCounts: {},
      hotkeys: {},
      guard: { globalEnabled: true }
    },
    update: vi.fn(),
    markHint: vi.fn()
  }),
  getCurrentConfig: vi.fn()
}));
vi.mock('@/stores/panels', () => ({
  usePanels: () => ({
    openSnippetDialog: vi.fn(),
    openQuickConnect: vi.fn(),
    openSettings: vi.fn(),
    snippetsRevision: 0
  })
}));
vi.mock('@/stores/hosts', () => ({
  useHosts: () => ({ hosts: [{ id: 42, guardEnabled: true }], openDrawer: vi.fn() })
}));
vi.mock('@/stores/events', () => ({
  useEvents: () => ({ addGuardUncertainEvent: vi.fn(), removeGuardUncertainEvent: vi.fn() })
}));
vi.mock('@/hooks/useHotkeys', () => ({ useHotkeys: vi.fn() }));
vi.mock('./XtermView', () => ({
  XtermView: () => null,
  destroyTerminal: vi.fn(),
  copySelection: vi.fn(),
  getSelection: vi.fn(() => ''),
  insertText: vi.fn(),
  getPendingLine: vi.fn(() => ''),
  confirmPendingLine: vi.fn(),
  pasteClipboardText: vi.fn(),
  pasteText: vi.fn(),
  focusTerminal: vi.fn()
}));

type BannerElement = ReactElement<{
  children?: ReactNode;
  onCloseIssue: (issue: DashboardAlertIssue) => void;
  onDismissIssue: ((issue: DashboardAlertIssue) => void) | undefined;
}>;

function findBanner(node: ReactNode): BannerElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findBanner(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  if (node.type === DashboardHealthBanner) return node as BannerElement;
  return findBanner((node as BannerElement).props.children);
}

describe('TerminalArea health notifications', () => {
  it('отделяет временное закрытие находки от персистентного IPC-мьюта', () => {
    vi.stubGlobal('window', { lucidSSH: { dismissDashboardAlert: ipcDismiss } });
    const banner = findBanner(TerminalArea());
    expect(banner).toBeDefined();

    banner?.props.onCloseIssue('cpu');
    expect(dismissDashboardAlertIssue).toHaveBeenCalledExactlyOnceWith('session-1', 'cpu');
    expect(ipcDismiss).not.toHaveBeenCalled();

    banner?.props.onDismissIssue?.('rebootRequired');
    expect(ipcDismiss).toHaveBeenCalledExactlyOnceWith(42, 'rebootRequired');
    expect(dismissDashboardAlertIssue).toHaveBeenLastCalledWith('session-1', 'rebootRequired');
  });
});
