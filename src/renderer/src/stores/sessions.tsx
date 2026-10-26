import type { JSX, ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AuthPromptRequest, HostKeyPrompt, SessionInfo, SessionStatus } from '@shared/ssh';
import type { Breadcrumb } from '@shared/breadcrumb';
import type { DashboardAlert, DashboardAlertIssue, DashboardMetrics } from '@shared/dashboard';
import type { ErrorExplanation } from '@shared/content';
import { parseQuickConnect } from '@shared/quickConnect';
import { enqueueHostKeyPrompt, removeHostKeyPrompt } from './hostKeyQueue';

/**
 * Стор SSH-сессий: список вкладок, активная сессия, ожидающие подтверждения
 * host key, breadcrumb и метрики дашборда по сессии. Renderer знает только
 * sessionId, статусы и данные-значения (SEC-05).
 */

/** HM-11: предложение сохранить как хост после первого разрешения Quick Connect. */
export interface SaveAsHostPrompt {
  sessionId: string;
  address: string;
  port: number;
  username: string;
}

/**
 * Факты об одной открытой вкладке, ранее жившие в пяти параллельных
 * `Record<sessionId, ...>` с независимой очисткой каждого — что однажды уже
 * привело к утечке (`label` не чистился в `closeTab`). Теперь одна запись на
 * sessionId, удаляемая одной операцией при закрытии вкладки.
 */
export interface SessionExtras {
  /** Промпт пароля/passphrase прямо в терминале (SSH-06). */
  authPrompt?: AuthPromptRequest;
  breadcrumb?: Breadcrumb;
  dashboard?: DashboardMetrics;
  /** DASH-09: одноразовый health-баннер — очищается закрытием (×), не приходит повторно. */
  dashboardAlert?: DashboardAlert;
  error?: ErrorExplanation;
  /** Локальное переименование вкладки (TERM-02); имя не уходит в main. */
  label?: string;
}

interface SessionsStore {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  /** Голова очереди промптов отпечатка — показывается в модалке, следующий
   *  после ответа на текущий (`hostKeyQueue.ts`). */
  hostKeyPrompt: HostKeyPrompt | null;
  sessionExtras: Record<string, SessionExtras>;
  dismissError: (sessionId: string) => void;
  dismissDashboardAlert: (sessionId: string) => void;
  /** DASH-09: «Больше не показывать» для одной находки — убирает её из уже
   *  открытого баннера (персистентность на диске делает вызывающий код). */
  dismissDashboardAlertIssue: (sessionId: string, issue: DashboardAlertIssue) => void;
  connect: (hostId: number) => Promise<void>;
  /** HM-11: подключение по `user@host[:port]` без сохранённого хоста. */
  connectQuick: (input: string) => Promise<void>;
  saveAsHostPrompt: SaveAsHostPrompt | null;
  dismissSaveAsHostPrompt: () => void;
  select: (sessionId: string) => void;
  closeTab: (sessionId: string) => Promise<void>;
  reconnect: (hostId: number, oldSessionId: string) => Promise<void>;
  answerHostKey: (decision: 'accept' | 'reject') => Promise<void>;
  answerAuthPrompt: (sessionId: string, answers: string[]) => Promise<void>;
  /** Локальное переименование вкладки (TERM-02); имя не уходит в main. */
  renameTab: (sessionId: string, name: string) => void;
  /** Drag-to-reorder вкладок: переместить sessionId перед targetId (null → в конец). */
  reorderTab: (sessionId: string, beforeId: string | null) => void;
}

const Ctx = createContext<SessionsStore | null>(null);

export function SessionsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [hostKeyQueue, setHostKeyQueue] = useState<HostKeyPrompt[]>([]);
  const hostKeyPrompt = hostKeyQueue[0] ?? null;
  const [sessionExtras, setSessionExtras] = useState<Record<string, SessionExtras>>({});
  // HM-11: sessionId → детали Quick Connect, ждущие первого connected/disconnected,
  // чтобы один раз предложить «Сохранить как хост?». Не влияет на рендер само по
  // себе — только читается/чистится, наружу отдаётся производный saveAsHostPrompt.
  const quickConnectPending = useRef(new Map<string, { address: string; port: number; username: string }>());
  const [saveAsHostPrompt, setSaveAsHostPrompt] = useState<SaveAsHostPrompt | null>(null);

  /** Точечный merge одного факта в запись сессии, остальные поля не трогает. */
  const setExtraField = useCallback(
    <K extends keyof SessionExtras>(sessionId: string, field: K, value: SessionExtras[K]) => {
      setSessionExtras((prev) => ({
        ...prev,
        [sessionId]: { ...prev[sessionId], [field]: value }
      }));
    },
    []
  );

  /** Точечная очистка одного факта записи сессии — соседние поля не трогает. */
  const clearExtraField = useCallback((sessionId: string, field: keyof SessionExtras) => {
    setSessionExtras((prev) => {
      const entry = prev[sessionId];
      if (!entry || entry[field] === undefined) return prev;
      const next = { ...entry };
      delete next[field];
      return { ...prev, [sessionId]: next };
    });
  }, []);

  useEffect(() => {
    const offStatus = window.lucidSSH.onSessionStatus(
      (sessionId: string, status: SessionStatus) => {
        setSessions((prev) =>
          prev.map((s) => (s.sessionId === sessionId ? { ...s, status } : s))
        );
        // Промпт пароля актуален только пока идёт подключение (SSH-06).
        if (status !== 'connecting') {
          clearExtraField(sessionId, 'authPrompt');
        }
        // HM-11: первое разрешение (успех или неуспех) — предложить сохранить хост.
        if (status === 'connected' || status === 'disconnected') {
          const pending = quickConnectPending.current.get(sessionId);
          if (pending) {
            quickConnectPending.current.delete(sessionId);
            setSaveAsHostPrompt({ sessionId, ...pending });
          }
        }
      }
    );
    const offPrompt = window.lucidSSH.onHostKeyPrompt((prompt) => {
      setHostKeyQueue((q) => enqueueHostKeyPrompt(q, prompt));
    });
    // Соединение промпта умерло до ответа (вкладку закрыли, обрыв сети) —
    // спрашивать про него больше не о чем.
    const offPromptCancelled = window.lucidSSH.onHostKeyPromptCancelled((requestId) => {
      setHostKeyQueue((q) => removeHostKeyPrompt(q, requestId));
    });
    const offAuthPrompt = window.lucidSSH.onAuthPrompt((prompt) => {
      setExtraField(prompt.sessionId, 'authPrompt', prompt);
    });
    const offCrumb = window.lucidSSH.onBreadcrumb((sessionId, crumb) => {
      setExtraField(sessionId, 'breadcrumb', crumb);
    });
    const offDash = window.lucidSSH.onDashboard((sessionId, metrics) => {
      setExtraField(sessionId, 'dashboard', metrics);
    });
    const offDashAlert = window.lucidSSH.onDashboardAlert((sessionId, alert) => {
      setExtraField(sessionId, 'dashboardAlert', alert);
    });
    const offError = window.lucidSSH.onError((sessionId, explanation) => {
      setExtraField(sessionId, 'error', explanation);
    });
    return () => {
      offStatus();
      offPrompt();
      offPromptCancelled();
      offAuthPrompt();
      offCrumb();
      offDash();
      offDashAlert();
      offError();
    };
  }, [setExtraField, clearExtraField]);

  const dismissError = useCallback(
    (sessionId: string) => clearExtraField(sessionId, 'error'),
    [clearExtraField]
  );

  const dismissDashboardAlert = useCallback(
    (sessionId: string) => clearExtraField(sessionId, 'dashboardAlert'),
    [clearExtraField]
  );

  const dismissDashboardAlertIssue = useCallback(
    (sessionId: string, issue: DashboardAlertIssue) => {
      setSessionExtras((prev) => {
        const alert = prev[sessionId]?.dashboardAlert;
        if (!alert) return prev;
        const issues = alert.issues.filter((i) => i !== issue);
        const entry = { ...prev[sessionId] };
        if (issues.length > 0) entry.dashboardAlert = { issues };
        else delete entry.dashboardAlert;
        return { ...prev, [sessionId]: entry };
      });
    },
    []
  );

  const applyLabels = useCallback(
    (list: SessionInfo[], extras: Record<string, SessionExtras>): SessionInfo[] =>
      list.map((s) => {
        const label = extras[s.sessionId]?.label;
        return label ? { ...s, hostName: label } : s;
      }),
    []
  );

  const connect = useCallback(
    async (hostId: number) => {
      const { sessionId } = await window.lucidSSH.connectHost(hostId);
      const list = await window.lucidSSH.listSessions();
      setSessions(applyLabels(list, sessionExtras));
      setActiveSessionId(sessionId);
    },
    [applyLabels, sessionExtras]
  );

  const connectQuick = useCallback(
    async (input: string) => {
      const parsed = parseQuickConnect(input);
      if (!parsed) throw new Error('invalid quick-connect input');
      const { sessionId } = await window.lucidSSH.connectQuick(input);
      quickConnectPending.current.set(sessionId, parsed);
      const list = await window.lucidSSH.listSessions();
      setSessions(applyLabels(list, sessionExtras));
      setActiveSessionId(sessionId);
    },
    [applyLabels, sessionExtras]
  );

  const dismissSaveAsHostPrompt = useCallback(() => setSaveAsHostPrompt(null), []);

  const renameTab = useCallback(
    (sessionId: string, name: string) => {
      const trimmed = name.trim().slice(0, 60);
      if (!trimmed) return;
      setExtraField(sessionId, 'label', trimmed);
      setSessions((prev) =>
        prev.map((s) => (s.sessionId === sessionId ? { ...s, hostName: trimmed } : s))
      );
    },
    [setExtraField]
  );

  const reorderTab = useCallback((sessionId: string, beforeId: string | null) => {
    setSessions((prev) => {
      const moving = prev.find((s) => s.sessionId === sessionId);
      if (!moving) return prev;
      const without = prev.filter((s) => s.sessionId !== sessionId);
      if (beforeId === null) return [...without, moving];
      const idx = without.findIndex((s) => s.sessionId === beforeId);
      if (idx < 0) return [...without, moving];
      return [...without.slice(0, idx), moving, ...without.slice(idx)];
    });
  }, []);

  const closeTab = useCallback(
    async (sessionId: string) => {
      await window.lucidSSH.destroySession(sessionId);
      setSessions((prev) => {
        const next = prev.filter((s) => s.sessionId !== sessionId);
        setActiveSessionId((cur) =>
          cur === sessionId ? (next[next.length - 1]?.sessionId ?? null) : cur
        );
        return next;
      });
      setSessionExtras((prev) => {
        if (!(sessionId in prev)) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
    },
    []
  );

  const reconnect = useCallback(
    async (hostId: number, oldSessionId: string) => {
      await closeTab(oldSessionId);
      await connect(hostId);
    },
    [closeTab, connect]
  );

  const answerHostKey = useCallback(
    async (decision: 'accept' | 'reject') => {
      if (!hostKeyPrompt) return;
      const { requestId } = hostKeyPrompt;
      await window.lucidSSH.confirmHostKey(requestId, decision);
      // По id, а не «снять голову»: пока шёл IPC, голова могла смениться.
      setHostKeyQueue((q) => removeHostKeyPrompt(q, requestId));
    },
    [hostKeyPrompt]
  );

  const answerAuthPrompt = useCallback(
    async (sessionId: string, answers: string[]) => {
      const prompt = sessionExtras[sessionId]?.authPrompt;
      if (!prompt) return;
      clearExtraField(sessionId, 'authPrompt');
      await window.lucidSSH.answerAuthPrompt(prompt.requestId, answers);
    },
    [sessionExtras, clearExtraField]
  );

  const value = useMemo<SessionsStore>(
    () => ({
      sessions,
      activeSessionId,
      hostKeyPrompt,
      sessionExtras,
      dismissError,
      dismissDashboardAlert,
      dismissDashboardAlertIssue,
      connect,
      connectQuick,
      saveAsHostPrompt,
      dismissSaveAsHostPrompt,
      select: setActiveSessionId,
      closeTab,
      reconnect,
      answerHostKey,
      answerAuthPrompt,
      renameTab,
      reorderTab
    }),
    [
      sessions,
      activeSessionId,
      hostKeyPrompt,
      sessionExtras,
      dismissError,
      dismissDashboardAlert,
      dismissDashboardAlertIssue,
      connect,
      connectQuick,
      saveAsHostPrompt,
      dismissSaveAsHostPrompt,
      closeTab,
      reconnect,
      answerHostKey,
      answerAuthPrompt,
      renameTab,
      reorderTab
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSessions(): SessionsStore {
  const store = useContext(Ctx);
  if (!store) throw new Error('useSessions outside SessionsProvider');
  return store;
}
