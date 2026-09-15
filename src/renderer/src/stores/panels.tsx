import type { JSX, ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { Snippet } from '@shared/history';

/**
 * Состояние выдвижных панелей/модалок истории и сниппетов. Триггерится из разных
 * мест (кнопка «История», контекстное меню терминала, строки истории), поэтому
 * вынесено в отдельный стор.
 */

/** Хост-источник диалога сохранения сниппета — только когда он ВАЖЕН явно
 *  (сохранение из строки истории, решение 3 spec.md «history-snippet-mark»):
 *  привязывает область «Для этого сервера» к хосту строки, а не к активной
 *  вкладке. undefined-поле означает «у строки нет живого хоста» (Быстрое
 *  подключение / хост удалён) — серверная область недоступна вовсе, не
 *  «использовать активную вкладку». Когда sourceHost не передан совсем
 *  (сохранение из терминала, редактирование из каталога) — область берётся
 *  из активной сессии, как раньше. */
interface SnippetDialogState {
  command: string;
  editSnippet?: Snippet;
  sourceHost?: { hostId?: number; hostName?: string };
}

/** Куда открыть окно справки: конкретная вкладка + опциональный якорь внутри неё. */
interface HelpTarget {
  tab?: string;
  anchor?: string;
}

interface PanelsStore {
  historyOpen: boolean;
  openHistory: () => void;
  closeHistory: () => void;
  settingsOpen: boolean;
  /** Раздел, на который открыть настройки (напр. «security» с иконки Стража
   *  у breadcrumb) — опционален, по умолчанию открывается последний раздел. */
  settingsSection: string | null;
  openSettings: (section?: string) => void;
  closeSettings: () => void;
  guideOpen: boolean;
  openGuide: () => void;
  closeGuide: () => void;
  /** HM-11: модалка «Быстрое подключение» (Ctrl+K / кнопка в футере хостов). */
  quickConnectOpen: boolean;
  openQuickConnect: () => void;
  closeQuickConnect: () => void;
  helpOpen: boolean;
  helpTarget: HelpTarget | null;
  openHelp: (target?: HelpTarget) => void;
  closeHelp: () => void;
  snippetDialog: SnippetDialogState | null;
  openSnippetDialog: (
    command: string,
    editSnippet?: Snippet,
    sourceHost?: { hostId?: number; hostName?: string }
  ) => void;
  closeSnippetDialog: () => void;
  /** WIN-04: поисковый запрос, который CatalogPanel должна подставить при
   *  открытии по ссылке из диалога закрытия (напр. карточка tmux). Разово —
   *  CatalogPanel сама сбрасывает после применения. */
  catalogQuery: string | null;
  openCatalogQuery: (query: string) => void;
  clearCatalogQuery: () => void;
  /** Ревизия сниппетов: инкремент после сохранения → HistoryDrawer перечитывает список. */
  snippetsRevision: number;
  bumpSnippets: () => void;
  /** Ревизия истории: инкремент при записи новой команды (main, ev:history-recorded)
   * → HistoryDrawer перечитывает список, даже если панель уже открыта. */
  historyRevision: number;
}

const Ctx = createContext<PanelsStore | null>(null);

export function PanelsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [quickConnectOpen, setQuickConnectOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpTarget, setHelpTarget] = useState<HelpTarget | null>(null);
  const [snippetDialog, setSnippetDialog] = useState<SnippetDialogState | null>(null);
  const [catalogQuery, setCatalogQuery] = useState<string | null>(null);
  const [snippetsRevision, setSnippetsRevision] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);

  useEffect(() => {
    return window.lucidSSH.onHistoryRecorded(() => setHistoryRevision((v) => v + 1));
  }, []);

  const value = useMemo<PanelsStore>(
    () => ({
      historyOpen,
      openHistory: () => setHistoryOpen(true),
      closeHistory: () => setHistoryOpen(false),
      settingsOpen,
      settingsSection,
      openSettings: (section) => {
        setSettingsSection(section ?? null);
        setSettingsOpen(true);
      },
      closeSettings: () => setSettingsOpen(false),
      guideOpen,
      openGuide: () => setGuideOpen(true),
      closeGuide: () => setGuideOpen(false),
      quickConnectOpen,
      openQuickConnect: () => setQuickConnectOpen(true),
      closeQuickConnect: () => setQuickConnectOpen(false),
      helpOpen,
      helpTarget,
      openHelp: (target) => {
        setHelpTarget(target ?? null);
        setHelpOpen(true);
      },
      closeHelp: () => setHelpOpen(false),
      snippetDialog,
      openSnippetDialog: (command, editSnippet, sourceHost) =>
        setSnippetDialog({ command, editSnippet, sourceHost }),
      closeSnippetDialog: () => setSnippetDialog(null),
      catalogQuery,
      openCatalogQuery: (query) => setCatalogQuery(query),
      clearCatalogQuery: () => setCatalogQuery(null),
      snippetsRevision,
      bumpSnippets: () => setSnippetsRevision((v) => v + 1),
      historyRevision
    }),
    [
      historyOpen,
      settingsOpen,
      settingsSection,
      guideOpen,
      quickConnectOpen,
      helpOpen,
      helpTarget,
      snippetDialog,
      catalogQuery,
      snippetsRevision,
      historyRevision
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePanels(): PanelsStore {
  const store = useContext(Ctx);
  if (!store) throw new Error('usePanels outside PanelsProvider');
  return store;
}
