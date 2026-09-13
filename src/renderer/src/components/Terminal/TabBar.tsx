import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionInfo } from '@shared/ssh';
import { QUICK_CONNECT_HOST_ID } from '@shared/quickConnect';
import { useSessions } from '@/stores/sessions';
import { useConfig } from '@/stores/config';
import { usePanels } from '@/stores/panels';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Icon } from '@/components/common/Icon';
import { TmuxHintLink } from '@/components/Terminal/TmuxHintLink';
import { useEscapeClose } from '@/hooks/useEscapeClose';

/**
 * Таб-бар сессий 38px (Design_Brief §3.3): статус-точка, имя, ×.
 * Двойной клик — переименование; правая кнопка — меню переименовать/дублировать/
 * закрыть (TERM-02, CTX-03). Закрытие активной сессии требует подтверждения (WIN-03).
 */

function StatusDot({ status }: { status: SessionInfo['status'] }): JSX.Element {
  if (status === 'connected') {
    return <span className="size-[7px] shrink-0 rounded-full bg-success-bright" />;
  }
  if (status === 'reconnecting' || status === 'connecting') {
    return (
      <span className="animate-[esh-pulse_1.2s_ease-in-out_infinite] size-[7px] shrink-0 rounded-full bg-warning" />
    );
  }
  return <span className="size-[7px] shrink-0 rounded-full bg-text-dim" />;
}

export function TabBar({
  onToggleDetails,
  onToggleCatalog,
  catalogOpen
}: {
  onToggleDetails: () => void;
  onToggleCatalog: () => void;
  catalogOpen: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const { sessions, activeSessionId, select, closeTab, connect, renameTab, reorderTab } =
    useSessions();
  const { update } = useConfig();
  const { openCatalogQuery } = usePanels();
  const [closeTarget, setCloseTarget] = useState<SessionInfo | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [menu, setMenu] = useState<{ x: number; session: SessionInfo } | null>(null);
  const dragSessionId = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Drop строки хоста из левой панели на таб-бар → открыть сессию (Design_Brief §4.4)
  const onHostDrop = (e: React.DragEvent): void => {
    const raw = e.dataTransfer.getData('application/x-lucidssh-host');
    if (raw) {
      const hostId = Number(raw);
      if (Number.isInteger(hostId) && hostId > 0) void connect(hostId);
    }
    setDragOverId(null);
  };

  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  const requestClose = (s: SessionInfo): void => {
    if (s.status === 'connected' || s.status === 'connecting' || s.status === 'reconnecting') {
      setCloseTarget(s); // WIN-03
      // WIN-04: busyCommand в закэшированном списке сессий может быть
      // устаревшим (команда стартовала/завершилась без пуш-события) —
      // перечитываем свежее состояние именно в момент запроса закрытия.
      void window.lucidSSH.listSessions().then((fresh) => {
        const match = fresh.find((x) => x.sessionId === s.sessionId);
        if (!match) return;
        // Диалог мог успеть закрыться (отмена) до того, как пришёл ответ.
        setCloseTarget((prev) => (prev?.sessionId === s.sessionId ? match : prev));
      });
    } else {
      void closeTab(s.sessionId);
    }
  };

  const openTmuxCard = (): void => {
    void update('ui.catalogPanelOpen', true);
    openCatalogQuery('tmux');
    setCloseTarget(null);
  };

  const startRename = (s: SessionInfo): void => {
    setRenamingId(s.sessionId);
    setRenameValue(s.hostName);
  };

  const commitRename = (): void => {
    if (renamingId) renameTab(renamingId, renameValue);
    setRenamingId(null);
  };

  // Незавершённая правка (ADR-0010): переименование вкладки — свой вход
  // стека, не завязанный на фокус инпута.
  useEscapeClose('tabbar-rename', () => setRenamingId(null), renamingId !== null);

  return (
    <div
      className="flex h-[38px] shrink-0 items-end border-b border-border-default bg-bg-base"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-lucidssh-host')) e.preventDefault();
      }}
      onDrop={onHostDrop}
    >
      <div className="flex min-w-0 flex-1 items-end gap-px overflow-x-auto [scrollbar-width:none]">
        {sessions.map((s) => {
          const activeTab = s.sessionId === activeSessionId;
          const isDragOver = dragOverId === s.sessionId;
          return (
            <div
              key={s.sessionId}
              role="tab"
              aria-selected={activeTab}
              tabIndex={0}
              draggable
              onDragStart={(e) => {
                dragSessionId.current = s.sessionId;
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (dragSessionId.current && dragSessionId.current !== s.sessionId) {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOverId(s.sessionId);
                }
              }}
              onDrop={(e) => {
                if (dragSessionId.current) {
                  e.preventDefault();
                  e.stopPropagation();
                  reorderTab(dragSessionId.current, s.sessionId);
                  dragSessionId.current = null;
                  setDragOverId(null);
                }
              }}
              onDragEnd={() => {
                dragSessionId.current = null;
                setDragOverId(null);
              }}
              onClick={() => select(s.sessionId)}
              onDoubleClick={() => startRename(s)}
              onContextMenu={(e) => {
                e.preventDefault();
                select(s.sessionId);
                setMenu({ x: e.clientX, session: s });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') select(s.sessionId);
              }}
              className={
                (activeTab
                  ? 'flex h-[38px] max-w-[190px] min-w-0 cursor-default items-center gap-2 rounded-t-[7px] border-t-2 border-t-accent bg-bg-tab-active px-[11px]'
                  : 'flex h-[38px] max-w-[190px] min-w-0 cursor-default items-center gap-2 rounded-t-[7px] border-t-2 border-t-transparent bg-bg-tab-idle px-[11px] hover:bg-bg-elevated') +
                (isDragOver ? ' shadow-[inset_2px_0_0_var(--color-accent)]' : '')
              }
            >
              <StatusDot status={s.status} />
              {renamingId === s.sessionId ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                  }}
                  maxLength={60}
                  className="h-[22px] w-[120px] rounded-[3px] border border-accent bg-bg-base px-1 text-[12px] text-text-strong outline-none"
                />
              ) : (
                <span
                  className={`truncate text-[12.5px] ${activeTab ? 'font-medium text-text-strong' : 'text-text-muted'}`}
                >
                  {s.hostName}
                </span>
              )}
              <button
                type="button"
                title={t('tabs.close')}
                aria-label={t('tabs.close')}
                onClick={(e) => {
                  e.stopPropagation();
                  requestClose(s);
                }}
                className="flex size-[16px] shrink-0 items-center justify-center rounded-[4px] text-text-dim hover:bg-[rgba(255,255,255,0.12)] hover:text-text-strong"
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex shrink-0 items-center pr-2 pb-[6px]">
        <button
          type="button"
          title={t('input.toggleCatalog')}
          aria-label={t('input.toggleCatalog')}
          onClick={onToggleCatalog}
          className={`flex size-[26px] items-center justify-center rounded-[4px] hover:bg-bg-elevated ${
            catalogOpen ? 'bg-accent/15 text-lavender' : 'text-text-muted hover:text-text-strong'
          }`}
        >
          <Icon name="catalog" size={15} />
        </button>
      </div>
      {menu && (
        <div
          className="animate-[esh-pop_.12s_ease] fixed z-50 w-[160px] rounded-[6px] border border-border-strong bg-bg-elevated py-1 shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
          style={{ left: Math.min(menu.x, window.innerWidth - 170), top: 40 }}
          onClick={(e) => e.stopPropagation()}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              startRename(menu.session);
              setMenu(null);
            }}
            className="w-full px-3 py-[6px] text-left text-[12.5px] text-text-body hover:bg-bg-elevated-2 hover:text-text-strong"
          >
            {t('tabs.rename')}
          </button>
          {/* HM-11: у Quick Connect сессии (hostId=0) нет хоста, дублировать некуда */}
          {menu.session.hostId !== QUICK_CONNECT_HOST_ID && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void connect(menu.session.hostId); // дублирование — новая сессия к тому же хосту
                setMenu(null);
              }}
              className="w-full px-3 py-[6px] text-left text-[12.5px] text-text-body hover:bg-bg-elevated-2 hover:text-text-strong"
            >
              {t('tabs.duplicate')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onToggleDetails();
              setMenu(null);
            }}
            className="w-full px-3 py-[6px] text-left text-[12.5px] text-text-body hover:bg-bg-elevated-2 hover:text-text-strong"
          >
            {t('tabs.details')}
          </button>
          <div className="my-1 h-px bg-border-hairline" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              requestClose(menu.session);
              setMenu(null);
            }}
            className="w-full px-3 py-[6px] text-left text-[12.5px] text-danger-text hover:bg-bg-elevated-2"
          >
            {t('tabs.close')}
          </button>
        </div>
      )}

      {closeTarget && (
        <ConfirmDialog
          title={t('tabs.closeConfirm.title')}
          confirmLabel={t('tabs.closeConfirm.confirm')}
          danger
          onConfirm={() => {
            void closeTab(closeTarget.sessionId);
            setCloseTarget(null);
          }}
          onCancel={() => setCloseTarget(null)}
        >
          <p>{t('tabs.closeConfirm.body', { name: closeTarget.hostName })}</p>
          {closeTarget.busyCommand !== null && (
            <>
              <p className="mt-2">
                {t('tabs.closeConfirm.commandRunning', { command: closeTarget.busyCommand })}
              </p>
              <TmuxHintLink onOpen={openTmuxCard} />
            </>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
