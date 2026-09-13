import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryEntry } from '@shared/history';
import { isSignalExitCode } from '@shared/ssh';
import { insertIntoComposer } from '@/stores/composerBus';
import { usePanels } from '@/stores/panels';
import { Icon } from '@/components/common/Icon';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useBackdropClose } from '@/hooks/useBackdropClose';
import { useEscapeClose } from '@/hooks/useEscapeClose';
import { QUICK_CONNECT_HOST_ID } from '@shared/quickConnect';
import { resolveClearTarget, showsSessionChip, type HostFilter } from './historyHostFilter';

/**
 * Панель истории команд (HistoryDrawer, Design_Brief §3.5; скриншот 06).
 * Выезжает справа. Поиск, фильтр-чипы, строки с копированием/вставкой/
 * сохранением в сниппет, заметками, статусами Стража, маскированными
 * секретами (HIST-01…07). Без вкладки «Избранное» — по ТЗ §3.13 ★-избранное
 * заменено кнопкой-закладкой → SnippetSaveDialog, отдельный список снипетов
 * уже есть в панели «Команды» (CatalogPanel), дублировать здесь не нужно.
 */

function relativeTime(iso: string, t: (k: string, o?: Record<string, number>) => string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return t('history.time.now');
  if (min < 60) return t('history.time.minutes', { count: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('history.time.hours', { count: h });
  return t('history.time.days', { count: Math.floor(h / 24) });
}

export function HistoryDrawer({ activeHostId }: { activeHostId?: number }): JSX.Element {
  const { t } = useTranslation();
  const { closeHistory, openSnippetDialog, historyRevision } = usePanels();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [hostFilter, setHostFilter] = useState<HostFilter>('all');
  const [noteEditing, setNoteEditing] = useState<number | null>(null);
  const [noteText, setNoteText] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearHostCount, setClearHostCount] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // «Эта сессия» очищает по хосту активной сессии, а не всё сразу (HIST-08);
  // Быстрое подключение — отдельная цель, не «хост» (см. historyHostFilter.ts).
  const clearTarget = resolveClearTarget(hostFilter, activeHostId);

  const openClearConfirm = async (): Promise<void> => {
    // «Эта сессия» указывала на сессию, которая с тех пор пропала (закрылась,
    // пока дровер оставался открытым) — не подставляем случайно «очистить
    // всё», а тихо возвращаемся к «Все».
    if (clearTarget.kind === 'stale') {
      setHostFilter('all');
      return;
    }
    if (clearTarget.kind !== 'all') {
      setClearHostCount(await window.lucidSSH.historyCountForHost(clearTarget.hostId));
    }
    setClearConfirmOpen(true);
  };

  const clearAll = async (): Promise<void> => {
    if (clearTarget.kind === 'host' || clearTarget.kind === 'quickConnect') {
      await window.lucidSSH.clearHistoryForHost(clearTarget.hostId);
      setHostFilter('all');
    } else if (clearTarget.kind === 'all') {
      await window.lucidSSH.clearHistory();
    }
    // 'stale' здесь означало бы, что цель пропала между открытием диалога и
    // подтверждением (см. openClearConfirm) — ничего не делаем, а не
    // откатываемся к полной очистке.
    setClearConfirmOpen(false);
    refreshHistory();
  };

  const refreshHistory = useCallback(() => {
    void window.lucidSSH.listHistory(query ? { text: query } : undefined).then(setEntries);
    void window.lucidSSH.historyCount().then(setTotal);
  }, [query]);

  useEffect(() => {
    refreshHistory();
    // historyRevision: перечитать при записи новой команды, даже пока панель открыта
    // (main шлёт ev:history-recorded — иначе список замирает на моменте открытия).
  }, [refreshHistory, historyRevision]);

  useEscapeClose('history-drawer', closeHistory);

  // Имена хостов копятся за время жизни дровера, а не пересчитываются с нуля
  // из текущего entries: иначе поиск, сузивший entries до нуля совпадений по
  // выбранному хосту, стирает и чип, и имя хоста в диалоге подтверждения
  // очистки (пустое «Очистить историю хоста «»?» перед необратимым удалением).
  // Мутация ref в теле рендера — принятый паттерн ленивого кеша (не эффект),
  // без гонок между рендером и useEffect.
  const hostNamesRef = useRef<Map<number, string>>(new Map());
  for (const e of entries) if (e.hostId !== undefined) hostNamesRef.current.set(e.hostId, e.hostName);

  const hostChips = [...hostNamesRef.current.entries()];

  // Подписи кнопки и диалога очистки — по цели (HIST-08). 'stale' диалог не
  // открывает (см. openClearConfirm), поэтому ему достаются подписи «Все».
  const clearTargetHostName =
    clearTarget.kind === 'host' ? (hostNamesRef.current.get(clearTarget.hostId) ?? '') : '';
  const clearCopy =
    clearTarget.kind === 'host'
      ? {
          button: t('history.clearHost'),
          title: t('history.clearHostConfirm.title', { host: clearTargetHostName }),
          body: t('history.clearHostConfirm.body', { host: clearTargetHostName, count: clearHostCount })
        }
      : clearTarget.kind === 'quickConnect'
        ? {
            button: t('history.clearQuickConnect'),
            title: t('history.clearQuickConnectConfirm.title'),
            body: t('history.clearQuickConnectConfirm.body', { count: clearHostCount })
          }
        : {
            button: t('history.clear'),
            title: t('history.clearConfirm.title'),
            body: t('history.clearConfirm.body', { total })
          };

  const visible = useMemo(
    () =>
      entries.filter((e) => {
        if (hostFilter === 'all') return true;
        if (hostFilter === 'session') return e.hostId === activeHostId;
        return e.hostId === hostFilter;
      }),
    [entries, hostFilter, activeHostId]
  );

  const saveNote = async (id: number): Promise<void> => {
    await window.lucidSSH.addHistoryNote(id, noteText);
    setNoteEditing(null);
    setNoteText('');
    refreshHistory();
  };

  const backdrop = useBackdropClose(closeHistory);

  // Незавершённая правка (ADR-0010): заметка редактируется поверх дровера —
  // регистрируется позже него, значит по LIFO получает Esc первой (живой баг
  // до этой миграции: Esc отменял правку и тут же закрывал весь дровер).
  useEscapeClose('history-drawer-note', () => setNoteEditing(null), noteEditing !== null);

  return (
    <div
      className="animate-[esh-fade_.15s_ease] fixed inset-0 z-50 bg-black/70"
      {...backdrop}
      role="presentation"
    >
      <aside
        className="animate-[esh-slidein_.22s_cubic-bezier(.2,.7,.3,1)] absolute top-0 right-0 flex h-full w-[560px] max-w-[92%] flex-col border-l border-border-strong bg-bg-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="shrink-0 border-b border-border-default px-[18px] pt-[15px] pb-3">
          <div className="flex items-center justify-between">
            <span className="text-[15px] font-semibold text-text-strong">{t('history.title')}</span>
            <button
              type="button"
              aria-label={t('common.close')}
              onClick={closeHistory}
              className="flex size-[24px] items-center justify-center rounded-[4px] text-text-muted hover:bg-bg-elevated hover:text-text-strong"
            >
              <Icon name="close" size={15} />
            </button>
          </div>
          <div className="relative mt-[11px]">
            <input
              ref={searchInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('history.searchPlaceholder')}
              className="h-8 w-full rounded-[4px] border border-border-default bg-bg-base px-3 pr-8 text-[12.5px] text-text-strong outline-none placeholder:text-text-dim focus:border-accent"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  searchInputRef.current?.focus();
                }}
                aria-label={t('history.searchClear')}
                className="absolute inset-y-0 right-2 flex w-6 items-center justify-center text-text-dim hover:text-text-strong"
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
          <div className="mt-[10px] flex flex-wrap gap-[6px]">
            <Chip active={hostFilter === 'all'} onClick={() => setHostFilter('all')}>
              {t('history.filterAll')}
            </Chip>
            {hostChips.map(([id, name]) => (
              <Chip key={id} active={hostFilter === id} onClick={() => setHostFilter(id)}>
                {id === QUICK_CONNECT_HOST_ID ? t('history.filterQuickConnect') : name}
              </Chip>
            ))}
            {showsSessionChip(activeHostId) && (
              <Chip active={hostFilter === 'session'} onClick={() => setHostFilter('session')}>
                {t('history.filterSession')}
              </Chip>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-2">
              {visible.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-6 pt-[54px] text-center">
                  <Icon name="save" size={34} strokeWidth={1.6} className="text-text-faint" />
                  <div className="text-[13px] font-medium text-text-body">
                    {query ? t('history.noMatches') : t('history.empty.title')}
                  </div>
                  <div className="max-w-[260px] text-[12px] leading-[1.5] text-text-muted">
                    {query ? t('history.noMatchesDesc') : t('history.empty.description')}
                  </div>
                </div>
              ) : (
                visible.map((e) => {
                  const expandable = e.guardStatus !== 'blocked';
                  const expanded = expandedId === e.id;
                  return (
                  <div key={e.id} className="border-b border-border-hairline py-[10px]">
                    <div className="flex items-center gap-[10px]">
                      <button
                        type="button"
                        disabled={!expandable}
                        onClick={() => expandable && setExpandedId(expanded ? null : e.id)}
                        className="flex min-w-0 flex-1 items-center gap-[6px] text-left font-mono text-[12.5px] text-text-strong hover:text-lavender disabled:cursor-default disabled:hover:text-text-strong"
                      >
                        {expandable && (
                          <Icon
                            name="chevron-right"
                            size={11}
                            className={`shrink-0 text-text-dim transition-transform ${expanded ? 'rotate-90' : ''}`}
                          />
                        )}
                        <span className="min-w-0 truncate">{e.command}</span>
                      </button>
                      {e.hasSecret && (
                        <span className="flex shrink-0 items-center gap-1 text-text-dim">
                          <Icon name="lock" size={13} />
                          <span className="text-[9.5px] font-semibold tracking-[0.03em]">
                            {t('history.secretHidden')}
                          </span>
                        </span>
                      )}
                      <div className="flex shrink-0 gap-1">
                        <IconBtn
                          title={t('history.copy')}
                          hoverColorClass="hover:text-info"
                          onClick={() => window.lucidSSH.clipboardWrite(e.command)}
                        >
                          <Icon name="copy" size={13} />
                        </IconBtn>
                        <IconBtn
                          title={t('history.insert')}
                          hoverColorClass="hover:text-success-bright"
                          onClick={() => insertIntoComposer(e.command)}
                        >
                          <Icon name="insert" size={13} />
                        </IconBtn>
                        <IconBtn
                          title={t('history.saveSnippet')}
                          hoverColorClass="hover:text-lavender"
                          onClick={() => openSnippetDialog(e.command)}
                        >
                          <Icon name="save" size={13} />
                        </IconBtn>
                        <IconBtn
                          title={t('history.delete')}
                          hoverColorClass="hover:text-danger"
                          onClick={() => void window.lucidSSH.deleteHistoryEntry(e.id).then(refreshHistory)}
                        >
                          <Icon name="trash" size={13} />
                        </IconBtn>
                      </div>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
                      <span
                        className={`size-[7px] rounded-full ${
                          e.exitCode === 0 || e.exitCode === undefined || isSignalExitCode(e.exitCode)
                            ? 'bg-success'
                            : 'bg-danger'
                        }`}
                      />
                      <span>
                        {e.hostName} · {e.username} · {relativeTime(e.startedAt, t)}
                        {e.exitCode !== undefined && ` · ${t('history.exit', { code: e.exitCode })}`}
                      </span>
                      {e.guardStatus === 'confirmed' && (
                        <span className="rounded-[4px] bg-warning/15 px-2 py-[1px] text-[10px] text-warning">
                          {t('history.confirmed')}
                        </span>
                      )}
                      {e.guardStatus === 'blocked' && (
                        <span className="rounded-[4px] bg-danger/15 px-2 py-[1px] text-[10px] text-danger">
                          {t('history.blocked')}
                        </span>
                      )}
                      {e.exitCode !== undefined && e.exitCode !== 0 && !isSignalExitCode(e.exitCode) && (
                        <span className="rounded-[4px] bg-danger/15 px-2 py-[1px] text-[10px] text-danger">
                          {t('history.error')}
                        </span>
                      )}
                    </div>
                    {noteEditing === e.id ? (
                      <input
                        autoFocus
                        value={noteText}
                        onChange={(ev) => setNoteText(ev.target.value)}
                        onBlur={() => void saveNote(e.id)}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Enter') void saveNote(e.id);
                        }}
                        placeholder={t('history.notePlaceholder')}
                        className="mt-[7px] h-7 w-full rounded-[4px] border border-border-strong bg-bg-base px-2 text-[12px] text-text-strong outline-none focus:border-accent"
                      />
                    ) : e.note ? (
                      <div className="mt-[7px] flex items-center gap-[7px] rounded-[4px] bg-warning/10 px-[9px] py-[6px] text-[11.5px] leading-[1.45] text-warning-text">
                        <Icon name="edit" size={11} className="shrink-0" />
                        <button
                          type="button"
                          onClick={() => {
                            setNoteEditing(e.id);
                            setNoteText(e.note ?? '');
                          }}
                          className="min-w-0 flex-1 truncate text-left hover:underline"
                        >
                          {e.note}
                        </button>
                        <button
                          type="button"
                          title={t('history.deleteNote')}
                          aria-label={t('history.deleteNote')}
                          onClick={() => void window.lucidSSH.addHistoryNote(e.id, '').then(refreshHistory)}
                          className="shrink-0 text-warning-text/70 hover:text-warning-text"
                        >
                          <Icon name="close" size={11} />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setNoteEditing(e.id);
                          setNoteText('');
                        }}
                        className="mt-1 text-[11px] text-text-dim hover:text-text-muted"
                      >
                        + {t('history.addNote')}
                      </button>
                    )}
                    {expanded && (
                      <div className="mt-[8px] rounded-[4px] border border-border-default bg-bg-base p-[9px]">
                        {e.output ? (
                          <>
                            <pre className="max-h-[220px] overflow-y-auto font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap text-text-body">
                              {e.output}
                            </pre>
                            {e.outputTruncated && (
                              <div className="mt-[6px] text-[10.5px] text-text-dim">
                                {t('history.output.truncated', { limit: 4000 })}
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="text-[11.5px] text-text-dim">
                            {e.hasSecret ? t('history.output.hiddenSecret') : t('history.output.empty')}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })
              )}
            </div>

        <div className="flex shrink-0 items-center justify-between border-t border-border-default px-[16px] py-[10px]">
          <span className="font-mono text-[11.5px] text-text-muted">
            {t('history.footer', { shown: visible.length, total })}
          </span>
          {total > 0 && (
            <button
              type="button"
              onClick={() => void openClearConfirm()}
              className="flex items-center gap-1 rounded-[4px] px-2 py-1 text-[11.5px] text-text-dim hover:bg-danger/10 hover:text-danger"
            >
              <Icon name="trash" size={12} />
              {clearCopy.button}
            </button>
          )}
        </div>
      </aside>

      {clearConfirmOpen && (
        <ConfirmDialog
          title={clearCopy.title}
          confirmLabel={t('history.clearConfirm.confirm')}
          danger
          onConfirm={() => void clearAll()}
          onCancel={() => setClearConfirmOpen(false)}
        >
          {clearCopy.body}
        </ConfirmDialog>
      )}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? 'rounded-[20px] border border-accent bg-accent/15 px-[11px] py-1 text-[11.5px] text-lavender-light'
          : 'rounded-[20px] border border-border-default px-[11px] py-1 text-[11.5px] text-text-muted hover:text-text-body'
      }
    >
      {children}
    </button>
  );
}

function IconBtn({
  title,
  onClick,
  hoverColorClass,
  children
}: {
  title: string;
  onClick: () => void;
  /** Цвет иконки на hover (как у SnippetRow в каталоге — только цвет, без фона). */
  hoverColorClass: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`flex size-[24px] items-center justify-center rounded-[4px] text-text-dim ${hoverColorClass}`}
    >
      {children}
    </button>
  );
}
