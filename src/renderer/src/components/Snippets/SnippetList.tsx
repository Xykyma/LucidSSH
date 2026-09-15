import type { JSX } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Snippet } from '@shared/history';
import { insertIntoComposer } from '@/stores/composerBus';
import { useConfig } from '@/stores/config';
import { Icon } from '@/components/common/Icon';
import { Segment } from '@/components/Settings/controls';

type SortMode = 'manual' | 'alpha' | 'date';

/** Порядок отображения (SNIP-10): ручной (как пришло от listSnippets — sort_order,
 * name), по алфавиту или по дате добавления (новые сначала). Пресет — только
 * состояние компонента, сбрасывается на «Ручной» при каждом открытии панели. */
function applySortMode(list: Snippet[], mode: SortMode): Snippet[] {
  if (mode === 'alpha') return [...list].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  if (mode === 'date') {
    return [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
  return list;
}

/**
 * Список сниппетов (SnippetRow, Design_Brief §3.4). Разбит на группы «Обычные» и
 * «Опасные». Клик по телу вставляет команду в композер (через Стража, SNIP-04);
 * иконки play/pencil/trash. Поиск по имени и описанию (SNIP-03). Ручная
 * drag-and-drop сортировка + пресеты «по алфавиту»/«по дате» (SNIP-10) —
 * только в режиме «Ручной» и вне активного поиска.
 */
export function SnippetList({
  snippets,
  highlightId,
  onChanged,
  onEdit
}: {
  snippets: Snippet[];
  activeHostId?: number;
  /** SNIP-12: сниппет прокручивается в видимую область и подсвечивается ~1с
   *  (решение 9 spec.md «history-snippet-mark») — переход из HistoryDrawer. */
  highlightId?: number | null;
  onChanged: () => void;
  onEdit: (s: Snippet) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { config } = useConfig();
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('manual');
  const [dragId, setDragId] = useState<number | null>(null);
  const [overRow, setOverRow] = useState<{ id: number; position: 'before' | 'after' } | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  // Вычисляется один раз — не меняется за время жизни панели (решение 9:
  // «при prefers-reduced-motion — без анимации», ни прокрутки, ни подсветки).
  const [reducedMotion] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  );

  // Сброс своего поиска при новой подсветке — иначе целевой сниппет может
  // быть отфильтрован текстом, оставшимся от прошлого открытия панели, и
  // scrollIntoView молча ничего не найдёт (rowRefs не содержит невидимых строк).
  useEffect(() => {
    if (highlightId != null) setQuery('');
  }, [highlightId]);

  const q = query.trim().toLowerCase();

  // Отдельный эффект от сброса выше: строка появляется в rowRefs только ПОСЛЕ
  // ре-рендера, вызванного очисткой query (setQuery выше не синхронный) — эта
  // зависимость от q гарантирует повторный запуск, когда фильтр реально снят.
  useEffect(() => {
    if (highlightId == null) return;
    rowRefs.current
      .get(highlightId)
      ?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
  }, [highlightId, reducedMotion, q]);
  const filtered = useMemo(
    () =>
      snippets.filter(
        (s) =>
          q === '' ||
          s.name.toLowerCase().includes(q) ||
          (s.description ?? '').toLowerCase().includes(q) ||
          s.command.toLowerCase().includes(q)
      ),
    [snippets, q]
  );
  const normal = applySortMode(
    filtered.filter((s) => !s.danger),
    sortMode
  );
  const danger = applySortMode(
    filtered.filter((s) => s.danger),
    sortMode
  );
  const dragEnabled = sortMode === 'manual' && q === '';

  const dropOnRow = async (groupList: Snippet[], targetId: number): Promise<void> => {
    if (!dragId || !overRow || overRow.id !== targetId || dragId === targetId) return;
    const ids = groupList.map((s) => s.id);
    const from = ids.indexOf(dragId);
    if (from === -1) return;
    ids.splice(from, 1);
    let to = ids.indexOf(targetId);
    if (overRow.position === 'after') to += 1;
    ids.splice(to, 0, dragId);
    setDragId(null);
    setOverRow(null);
    await window.lucidSSH.reorderSnippets(ids);
    onChanged();
  };

  if (snippets.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-5 py-[44px] text-center">
        <div className="text-[13px] font-semibold text-text-body">{t('snippet.empty.title')}</div>
        <div className="text-[12px] text-text-faint">
          {t(
            config?.terminal.rightClickPaste
              ? 'snippet.empty.descriptionPasteMode'
              : 'snippet.empty.description'
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-5 pt-3 pb-1">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('snippet.searchPlaceholder')}
          className="h-8 w-full rounded-[6px] border border-border-strong bg-bg-base px-3 text-[12.5px] text-text-strong outline-none placeholder:text-text-dim focus:border-accent"
        />
      </div>
      <div className="shrink-0 px-5 pb-2">
        <Segment
          value={sortMode}
          onChange={setSortMode}
          options={[
            { key: 'manual', label: t('snippet.sort.manual') },
            { key: 'alpha', label: t('snippet.sort.alpha') },
            { key: 'date', label: t('snippet.sort.date') }
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {normal.length > 0 && (
          <Group label={t('snippet.groupNormal')}>
            {normal.map((s) => (
              <SnippetRow
                key={s.id}
                snippet={s}
                highlighted={s.id === highlightId}
                rowRef={(el) => {
                  if (el) rowRefs.current.set(s.id, el);
                  else rowRefs.current.delete(s.id);
                }}
                onChanged={onChanged}
                onEdit={onEdit}
                draggable={dragEnabled}
                isDragging={dragId === s.id}
                dropIndicator={overRow?.id === s.id ? overRow.position : null}
                onDragStartReorder={() => setDragId(s.id)}
                onDragOverReorder={(position) => setOverRow({ id: s.id, position })}
                onDropReorder={() => void dropOnRow(normal, s.id)}
                onDragEndReorder={() => {
                  setDragId(null);
                  setOverRow(null);
                }}
              />
            ))}
          </Group>
        )}
        {danger.length > 0 && (
          <Group label={t('snippet.groupDanger')} danger>
            {danger.map((s) => (
              <SnippetRow
                key={s.id}
                snippet={s}
                highlighted={s.id === highlightId}
                rowRef={(el) => {
                  if (el) rowRefs.current.set(s.id, el);
                  else rowRefs.current.delete(s.id);
                }}
                onChanged={onChanged}
                onEdit={onEdit}
                draggable={dragEnabled}
                isDragging={dragId === s.id}
                dropIndicator={overRow?.id === s.id ? overRow.position : null}
                onDragStartReorder={() => setDragId(s.id)}
                onDragOverReorder={(position) => setOverRow({ id: s.id, position })}
                onDropReorder={() => void dropOnRow(danger, s.id)}
                onDragEndReorder={() => {
                  setDragId(null);
                  setOverRow(null);
                }}
              />
            ))}
          </Group>
        )}
      </div>
    </div>
  );
}

function Group({
  label,
  danger,
  children
}: {
  label: string;
  danger?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="mb-2">
      <div
        className={`flex items-center gap-1 px-2 py-1 text-[10.5px] font-semibold tracking-[0.05em] uppercase ${danger ? 'text-warning' : 'text-text-dim'}`}
      >
        {danger && <Icon name="alert" size={11} />}
        {label}
      </div>
      {children}
    </div>
  );
}

function SnippetRow({
  snippet,
  highlighted,
  rowRef,
  onChanged,
  onEdit,
  draggable,
  isDragging,
  dropIndicator,
  onDragStartReorder,
  onDragOverReorder,
  onDropReorder,
  onDragEndReorder
}: {
  snippet: Snippet;
  /** SNIP-12: подсветка после перехода из HistoryDrawer (см. SnippetList). */
  highlighted?: boolean;
  rowRef: (el: HTMLDivElement | null) => void;
  onChanged: () => void;
  onEdit: (s: Snippet) => void;
  draggable: boolean;
  isDragging: boolean;
  dropIndicator: 'before' | 'after' | null;
  onDragStartReorder: () => void;
  onDragOverReorder: (position: 'before' | 'after') => void;
  onDropReorder: () => void;
  onDragEndReorder: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  // Индикатор вставки — тонкая полоса сверху/снизу строки (как в HostPanel.tsx)
  const indicatorClass =
    dropIndicator === 'before'
      ? 'after:absolute after:inset-x-2 after:top-0 after:h-[2px] after:rounded-full after:bg-accent after:content-[""]'
      : dropIndicator === 'after'
        ? 'after:absolute after:inset-x-2 after:bottom-0 after:h-[2px] after:rounded-full after:bg-accent after:content-[""]'
        : '';
  return (
    <div
      ref={rowRef}
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) return;
        e.dataTransfer.setData('application/x-lucidssh-snippet-reorder', String(snippet.id));
        e.dataTransfer.effectAllowed = 'move';
        onDragStartReorder();
      }}
      onDragOver={(e) => {
        if (!draggable || !e.dataTransfer.types.includes('application/x-lucidssh-snippet-reorder')) {
          return;
        }
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const position = e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
        onDragOverReorder(position);
      }}
      onDrop={(e) => {
        if (!draggable || !e.dataTransfer.types.includes('application/x-lucidssh-snippet-reorder')) {
          return;
        }
        e.preventDefault();
        onDropReorder();
      }}
      onDragEnd={onDragEndReorder}
      className={
        `group relative flex items-center gap-2 rounded-[5px] border-b border-border-hairline px-2 py-[8px] hover:bg-bg-elevated${isDragging ? ' opacity-40' : ''}` +
        (indicatorClass ? ` ${indicatorClass}` : '') +
        (highlighted ? ' esh-highlight-once' : '')
      }
      onClick={() => insertIntoComposer(snippet.command)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') insertIntoComposer(snippet.command);
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span
            className={`truncate text-[12.5px] font-medium ${snippet.danger ? 'text-danger-text' : 'text-text-strong'}`}
          >
            {snippet.name}
          </span>
          <span className="shrink-0 rounded-[3px] bg-bg-elevated-2 px-[5px] text-[9.5px] text-text-dim">
            {snippet.hostId != null ? t('snippet.chipServer') : t('snippet.chipGlobal')}
          </span>
        </div>
        <div className="truncate font-mono text-[11px] text-text-muted">{snippet.command}</div>
      </div>
      <div className="flex shrink-0 gap-[1px]">
        <button
          type="button"
          title={t('snippet.insert')}
          aria-label={t('snippet.insert')}
          onClick={(e) => {
            e.stopPropagation();
            insertIntoComposer(snippet.command);
          }}
          className="flex size-[22px] items-center justify-center rounded-[4px] text-text-dim hover:text-success-bright"
        >
          <Icon name="insert" size={13} />
        </button>
        <button
          type="button"
          title={t('snippet.edit')}
          aria-label={t('snippet.edit')}
          onClick={(e) => {
            e.stopPropagation();
            onEdit(snippet);
          }}
          className="flex size-[22px] items-center justify-center rounded-[4px] text-text-dim hover:text-lavender"
        >
          <Icon name="edit" size={13} />
        </button>
        <button
          type="button"
          title={t('snippet.delete')}
          aria-label={t('snippet.delete')}
          onClick={(e) => {
            e.stopPropagation();
            void window.lucidSSH.deleteSnippet(snippet.id).then(onChanged);
          }}
          className="flex size-[22px] items-center justify-center rounded-[4px] text-text-dim hover:text-danger"
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
    </div>
  );
}
