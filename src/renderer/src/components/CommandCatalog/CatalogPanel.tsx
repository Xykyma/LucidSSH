import type { JSX } from 'react';
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CatalogCommand, CommandsDatabase } from '@shared/content';
import type { Snippet } from '@shared/history';
import { QUICK_CONNECT_HOST_ID } from '@shared/quickConnect';
import { insertIntoComposer } from '@/stores/composerBus';
import { useSessions } from '@/stores/sessions';
import { usePanels } from '@/stores/panels';
import { useConfig } from '@/stores/config';
import { SnippetList } from '@/components/Snippets/SnippetList';
import { Icon } from '@/components/common/Icon';

/**
 * Правая панель — каталог команд (CAT-01…05; Design_Brief §3.4).
 * Категории с горизонтальным скроллом, карточки команд с флаг-чипами; клик по
 * имени/флагу вставляет команду в композер (проходит через Стража, CAT-04).
 * Русский поиск по имени и keywords (CAT-05). Сниппет-вкладки — Этап 7.
 */
export const CatalogPanel = forwardRef<HTMLElement, { width: number; onClose: () => void }>(
  function CatalogPanel({ width, onClose }, ref): JSX.Element {
    const { t, i18n } = useTranslation();
    const { sessions, activeSessionId } = useSessions();
    const { openSnippetDialog, snippetsRevision, catalogRequest, clearCatalogRequest } = usePanels();
    const { config } = useConfig();
    // SET-05(а)/CAT-06: новичковый режим показывает описание флага рядом с
    // ним в чипе; в режиме эксперта чип — только сам флаг, как в макете.
    const verboseFlags = config?.ui.hints.commandCatalog ?? true;
    const active = sessions.find((s) => s.sessionId === activeSessionId);
    const [db, setDb] = useState<CommandsDatabase | null>(null);
    const [category, setCategory] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [tab, setTab] = useState<'catalog' | 'server' | 'global'>('catalog');
    const [snippets, setSnippets] = useState<Snippet[]>([]);
    const [highlightSnippetId, setHighlightSnippetId] = useState<number | null>(null);
    const catStripRef = useRef<HTMLDivElement>(null);
    const tabStripRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);

    // Перезапрашивает базу при смене языка (i18n.language) — main-процесс
    // мержит контент-базы под активный язык и отдаёт их не через t(), а
    // отдельным IPC-вызовом, поэтому обычная реактивность react-i18next сюда
    // не долетает без явной зависимости.
    useEffect(() => {
      void window.lucidSSH.getCommandCatalog().then((d) => {
        setDb(d);
        setCategory((prev) =>
          prev !== null && (d.categories as string[]).includes(prev) ? prev : (d.categories[0] ?? null)
        );
      });
    }, [i18n.language]);

    // Сниппеты для вкладок [хост]/Глобальные; обновляются при сохранении (SNIP-05)
    const refreshSnippets = useCallback(() => {
      void window.lucidSSH.listSnippets(active?.hostId).then(setSnippets);
    }, [active?.hostId]);
    useEffect(() => {
      refreshSnippets();
    }, [refreshSnippets, snippetsRevision]);

    // Серверная область есть только у сессии с сохранённым хостом: hostId=0 —
    // Быстрое подключение (HM-11), записи в hosts нет, серверных сниппетов
    // быть не может (SnippetSaveDialog запрещает их создание).
    const hostScope = active && active.hostId !== QUICK_CONNECT_HOST_ID ? active : null;

    // Если активный хост исчез, а открыта его вкладка — вернуться к каталогу
    useEffect(() => {
      if (tab === 'server' && !hostScope) setTab('catalog');
    }, [tab, hostScope]);

    // Разовый запрос (решение 9 spec.md «history-snippet-mark», обобщение
    // WIN-04): вкладка/поиск («карточка tmux» из диалога закрытия) и/или
    // сниппет для прокрутки+подсветки (SNIP-12, из HistoryDrawer).
    useEffect(() => {
      if (catalogRequest === null) return;
      if (catalogRequest.query !== undefined) setQuery(catalogRequest.query);
      if (catalogRequest.tab !== undefined) setTab(catalogRequest.tab);
      if (catalogRequest.snippetId !== undefined) setHighlightSnippetId(catalogRequest.snippetId);
      clearCatalogRequest();
    }, [catalogRequest, clearCatalogRequest]);

    // Подсветка держится ~1с (решение 9) — дольше самой CSS-анимации не нужна,
    // сброс снимает временный highlighted-класс со строки в SnippetList.
    useEffect(() => {
      if (highlightSnippetId === null) return;
      const timer = setTimeout(() => setHighlightSnippetId(null), 1000);
      return () => clearTimeout(timer);
    }, [highlightSnippetId]);

    const serverSnips = snippets.filter((s) => s.hostId != null && s.hostId === hostScope?.hostId);
    const globalSnips = snippets.filter((s) => s.hostId == null);

    const q = query.trim().toLowerCase();
    const filtered = useMemo(() => {
      if (!db) return [];
      const inCategory = (c: CatalogCommand): boolean => q !== '' || c.category === category;
      const matchesQuery = (c: CatalogCommand): boolean =>
        q === '' ||
        c.name.toLowerCase().includes(q) ||
        c.summary.toLowerCase().includes(q) ||
        c.keywords.some((k) => k.toLowerCase().includes(q));
      return db.commands.filter((c) => inCategory(c) && matchesQuery(c));
    }, [db, category, q]);

    const scrollCats = (dir: number): void => {
      catStripRef.current?.scrollBy({ left: dir * 90, behavior: 'smooth' });
    };

    // Прокрутка категорий зажатой кнопкой мыши (как в макете, title
    // "Прокрути с зажатой кнопкой мыши") — в дополнение к стрелкам.
    const dragState = useRef<{ startX: number; startLeft: number } | null>(null);
    const onCatStripMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
      const el = catStripRef.current;
      if (!el) return;
      dragState.current = { startX: e.clientX, startLeft: el.scrollLeft };
      const onMove = (mv: MouseEvent): void => {
        if (!dragState.current || !catStripRef.current) return;
        catStripRef.current.scrollLeft = dragState.current.startLeft - (mv.clientX - dragState.current.startX);
      };
      const onUp = (): void => {
        dragState.current = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    // Прокрутка вкладок Каталог/[хост]/Глобальные зажатой кнопкой мыши — тот
    // же приём, что и у строки категорий выше (тут нет reorder, в отличие от
    // вкладок сессий, поэтому drag-скролл ничему не мешает).
    const tabDragState = useRef<{ startX: number; startLeft: number } | null>(null);
    const onTabStripMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
      const el = tabStripRef.current;
      if (!el) return;
      tabDragState.current = { startX: e.clientX, startLeft: el.scrollLeft };
      const onMove = (mv: MouseEvent): void => {
        if (!tabDragState.current || !tabStripRef.current) return;
        tabStripRef.current.scrollLeft = tabDragState.current.startLeft - (mv.clientX - tabDragState.current.startX);
      };
      const onUp = (): void => {
        tabDragState.current = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    return (
      <aside
        ref={ref}
        style={{ width }}
        className="flex shrink-0 flex-col border-l border-border-default bg-bg-panel"
      >
        <div className="flex h-[38px] shrink-0 items-center justify-between pr-2 pl-3">
          <span className="text-[12px] font-semibold tracking-[0.04em] text-text-muted uppercase">
            {t('catalog.title')}
          </span>
          <button
            type="button"
            title={t('catalog.close')}
            aria-label={t('catalog.close')}
            onClick={onClose}
            className="flex size-[22px] items-center justify-center rounded-[4px] text-text-dim hover:bg-bg-elevated hover:text-text-strong"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        {/* Вкладки: Каталог · [хост] · Глобальные (SNIP-05) */}
        <div
          ref={tabStripRef}
          onMouseDown={onTabStripMouseDown}
          title={t('catalog.dragScroll')}
          className="flex h-[32px] shrink-0 cursor-grab items-end gap-[2px] overflow-x-auto border-b border-border-default px-3 select-none [scrollbar-width:none]"
        >
          <TabButton active={tab === 'catalog'} onClick={() => setTab('catalog')}>
            {t('catalog.tabCatalog')}
          </TabButton>
          {hostScope && (
            <TabButton active={tab === 'server'} onClick={() => setTab('server')}>
              {hostScope.hostName}
            </TabButton>
          )}
          <TabButton active={tab === 'global'} onClick={() => setTab('global')}>
            <Icon name="globe" size={12} className="mr-[5px] inline-block align-[-1px]" />
            {t('catalog.tabGlobal')}
          </TabButton>
        </div>

        {tab !== 'catalog' ? (
          <SnippetList
            snippets={tab === 'server' ? serverSnips : globalSnips}
            activeHostId={hostScope?.hostId}
            highlightId={highlightSnippetId}
            onChanged={refreshSnippets}
            onEdit={(s) => openSnippetDialog(s.command, s)}
          />
        ) : (
          <>
        <div className="relative px-3 pt-[10px] pb-2">
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('catalog.searchPlaceholder')}
            className="h-7 w-full rounded-[4px] border border-border-default bg-bg-base px-[9px] pr-7 text-[12px] text-text-strong outline-none placeholder:text-text-dim focus:border-accent"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                searchInputRef.current?.focus();
              }}
              aria-label={t('catalog.searchClear')}
              className="absolute inset-y-0 right-3 flex w-6 items-center justify-center text-text-dim hover:text-text-strong"
            >
              <Icon name="close" size={12} />
            </button>
          )}
        </div>

        {/* Категории — остаются видимыми и во время поиска (как в макете); */}
        {/* сам поиск ищет по всей базе, не только в выбранной категории. */}
        {db && (
          <div className="relative shrink-0 border-b border-border-default">
            <button
              type="button"
              onClick={() => scrollCats(-1)}
              aria-label="‹"
              className="absolute inset-y-0 bottom-2 left-0 z-10 flex w-[22px] items-center justify-center bg-[linear-gradient(to_right,var(--color-bg-panel)_55%,transparent)] text-text-dim hover:text-text-strong"
            >
              <Icon name="chevron-left" size={14} />
            </button>
            <div
              ref={catStripRef}
              onMouseDown={onCatStripMouseDown}
              title={t('catalog.dragScroll')}
              className="flex cursor-grab gap-[2px] overflow-x-auto px-[22px] pb-2 select-none [scrollbar-width:none]"
            >
              {db.categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategory(cat)}
                  className={
                    category === cat
                      ? 'shrink-0 border-b-2 border-accent px-2 py-[5px] text-[11.5px] font-medium whitespace-nowrap text-text-strong'
                      : 'shrink-0 border-b-2 border-transparent px-2 py-[5px] text-[11.5px] whitespace-nowrap text-text-dim hover:text-text-muted'
                  }
                >
                  {db.categoryLabels[cat] ?? cat}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => scrollCats(1)}
              aria-label="›"
              className="absolute inset-y-0 right-0 bottom-2 z-10 flex w-[22px] items-center justify-center bg-[linear-gradient(to_left,var(--color-bg-panel)_55%,transparent)] text-text-dim hover:text-text-strong"
            >
              <Icon name="chevron-right" size={14} />
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-[7px] overflow-y-auto px-[10px] py-2">
          {filtered.map((cmd) => (
            <CommandCard key={cmd.name} cmd={cmd} verboseFlags={verboseFlags} />
          ))}
        </div>
          </>
        )}
      </aside>
    );
  }
);

function TabButton({
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
          ? 'flex h-[32px] shrink-0 items-center rounded-t-[7px] border-b-2 border-accent bg-bg-tab-active px-[11px] text-[12px] font-medium whitespace-nowrap text-text-strong'
          : 'flex h-[32px] shrink-0 items-center rounded-t-[7px] border-b-2 border-transparent px-[11px] text-[12px] whitespace-nowrap text-text-dim hover:text-text-muted'
      }
    >
      {children}
    </button>
  );
}

function CommandCard({
  cmd,
  verboseFlags
}: {
  cmd: CatalogCommand;
  verboseFlags: boolean;
}): JSX.Element {
  return (
    <div className="rounded-[6px] border border-border-default bg-bg-elevated px-[10px] py-[9px]">
      <div className="flex items-baseline gap-2">
        <button
          type="button"
          onClick={() => insertIntoComposer(`${cmd.name} `)}
          className="font-mono text-[13px] font-semibold text-lavender hover:underline"
        >
          {cmd.name}
        </button>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-muted">
          {cmd.summary}
        </span>
        {cmd.dangerous && (
          <Icon name="alert" size={14} className="shrink-0 self-center text-warning" />
        )}
      </div>
      {cmd.flags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-[5px]">
          {cmd.flags.map((f) =>
            verboseFlags ? (
              <button
                key={f.flag}
                type="button"
                title={f.desc}
                onClick={() => insertIntoComposer(`${cmd.name} ${f.flag} `)}
                className="flex items-center gap-1 rounded-[4px] border border-border-strong bg-bg-elevated-2 px-2 py-[3px] text-[11px] hover:border-accent"
              >
                <span className="font-mono font-semibold text-text-strong">{f.flag}</span>
                <span className="text-text-dim">{f.desc}</span>
              </button>
            ) : (
              <button
                key={f.flag}
                type="button"
                title={f.desc}
                onClick={() => insertIntoComposer(`${cmd.name} ${f.flag} `)}
                className="rounded-[4px] border border-border-strong bg-bg-elevated-2 px-[7px] py-[2px] font-mono text-[11px] text-text-body hover:border-accent hover:text-text-strong"
              >
                {f.flag}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
