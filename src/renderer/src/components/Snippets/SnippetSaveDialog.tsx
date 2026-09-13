import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Snippet } from '@shared/history';
import { QUICK_CONNECT_HOST_ID } from '@shared/quickConnect';
import { Icon } from '@/components/common/Icon';
import { useBackdropClose } from '@/hooks/useBackdropClose';
import { useEscapeClose } from '@/hooks/useEscapeClose';

/**
 * SnippetSaveDialog (SNIP-01, SNIP-05; Design_Brief §3.5). Модалка 440px:
 * превью команды (только чтение), предупреждение об опасной команде, сегмент
 * области видимости (сервер/глобальная, дефолт — сервер), обязательное имя,
 * описание. «Сохранить» активна только при непустом имени.
 */

// Эвристика подсветки опасной команды в превью (окончательно — Страж).
const DANGER_HINT =
  /\b(rm\s+-[rf]|mkfs|dd\s+if=|:\(\)\{|chmod\s+-R\s+777|kill\s+-9|drop\s+database|>\s*\/dev\/|--force)/i;

export function SnippetSaveDialog({
  command,
  editSnippet,
  hostId,
  hostName,
  onSaved,
  onClose
}: {
  command: string;
  editSnippet?: Snippet;
  hostId?: number; // хост активной сессии (для области «сервер»)
  hostName?: string;
  onSaved: () => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState(editSnippet?.name ?? '');
  const [description, setDescription] = useState(editSnippet?.description ?? '');
  // По умолчанию «Для сервера», если есть активный хост (SNIP-05).
  // hostId=0 — Quick Connect (HM-11), считается «нет хоста», как undefined.
  const initialScope: 'server' | 'global' = editSnippet
    ? editSnippet.hostId != null
      ? 'server'
      : 'global'
    : hostId != null && hostId !== QUICK_CONNECT_HOST_ID
      ? 'server'
      : 'global';
  const [scope, setScope] = useState<'server' | 'global'>(initialScope);
  const [busy, setBusy] = useState(false);

  const cmd = editSnippet?.command ?? command;
  const danger = DANGER_HINT.test(cmd);
  const canSave = name.trim().length > 0 && !busy;
  // hostId=0 — Quick Connect (HM-11), нет реального хоста: серверный скоуп недоступен,
  // иначе снипет «приклеится» ко всем последующим Quick Connect сессиям (общий сентинел).
  const canPickServer = (hostId != null && hostId !== QUICK_CONNECT_HOST_ID) || editSnippet?.hostId != null;
  const serverHostId = hostId ?? editSnippet?.hostId;
  const targetHostId = scope === 'server' ? serverHostId : undefined;

  // Предупреждение о дубликате команды в том же скоупе (не блокирует сохранение).
  const [duplicate, setDuplicate] = useState<Snippet | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.lucidSSH
      .findDuplicateSnippet(cmd, targetHostId, editSnippet?.id)
      .then((d) => {
        if (!cancelled) setDuplicate(d);
      });
    return () => {
      cancelled = true;
    };
  }, [cmd, targetHostId, editSnippet?.id]);

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setBusy(true);
    try {
      if (editSnippet) {
        await window.lucidSSH.updateSnippet(editSnippet.id, {
          name: name.trim(),
          description: description.trim() || undefined,
          // null — явный сигнал «сделать глобальным» (undefined main трактует
          // как «поле не трогать», иначе смена области на глобальную не сохранялась)
          hostId: targetHostId ?? null
        });
      } else {
        await window.lucidSSH.createSnippet({
          name: name.trim(),
          command: cmd,
          description: description.trim() || undefined,
          hostId: targetHostId
        });
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    'h-[34px] w-full rounded-[4px] border border-border-strong bg-bg-base px-[10px] text-[13px] text-text-strong outline-none placeholder:text-text-dim focus:border-accent';

  const backdrop = useBackdropClose(onClose);
  useEscapeClose('snippet-save-dialog', onClose);

  return (
    <div
      className="animate-[esh-fade_.15s_ease] fixed inset-0 z-[60] flex items-center justify-center bg-black/70"
      {...backdrop}
      role="presentation"
    >
      <div
        className="animate-[esh-pop_.16s_ease] w-[440px] max-w-[92%] rounded-[10px] border border-border-strong bg-bg-elevated shadow-[0_24px_60px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center gap-2 px-[18px] pt-[15px]">
          <Icon name="bookmark" size={16} className="text-lavender" />
          <span className="text-[14.5px] font-semibold text-text-strong">
            {editSnippet ? t('snippet.editTitle') : t('snippet.saveTitle')}
          </span>
        </div>

        <div className="space-y-3 px-[18px] pt-[14px] pb-[18px]">
          {/* Превью команды */}
          <div className="truncate rounded-[6px] border border-[rgba(255,255,255,0.06)] bg-bg-panel px-[11px] py-[10px] font-mono text-[12px] text-text-body">
            {cmd}
          </div>

          {danger && (
            <div className="flex items-center gap-2 rounded-[6px] border border-warning/25 bg-warning/10 px-3 py-2 text-[11.5px] text-warning-text">
              <Icon name="alert" size={14} className="shrink-0" /> {t('snippet.dangerWarn')}
            </div>
          )}

          {duplicate && (
            <div className="flex items-center gap-2 rounded-[6px] border border-warning/25 bg-warning/10 px-3 py-2 text-[11.5px] text-warning-text">
              <Icon name="alert" size={14} className="shrink-0" />
              {t('snippet.duplicateWarn', { name: duplicate.name })}
            </div>
          )}

          {/* Область видимости */}
          <div>
            <span className="mb-[5px] block text-[12px] font-medium text-text-strong">
              {t('snippet.scopeLabel')}
            </span>
            <div className="flex gap-[3px] rounded-[7px] border border-border-default bg-bg-base p-[3px]">
              <button
                type="button"
                disabled={!canPickServer}
                onClick={() => setScope('server')}
                className={
                  scope === 'server'
                    ? 'h-[30px] flex-1 rounded-[5px] bg-bg-tab-active text-[12px] font-medium text-text-strong'
                    : 'h-[30px] flex-1 rounded-[5px] text-[12px] text-text-dim hover:text-text-muted disabled:opacity-40'
                }
              >
                {hostName ? `${t('snippet.scopeServer')}: ${hostName}` : t('snippet.scopeServer')}
              </button>
              <button
                type="button"
                onClick={() => setScope('global')}
                className={
                  scope === 'global'
                    ? 'h-[30px] flex-1 rounded-[5px] bg-bg-tab-active text-[12px] font-medium text-text-strong'
                    : 'h-[30px] flex-1 rounded-[5px] text-[12px] text-text-dim hover:text-text-muted'
                }
              >
                {t('snippet.scopeGlobal')}
              </button>
            </div>
            <div className="mt-1 text-[11px] text-text-dim">{t('snippet.scopeHint')}</div>
          </div>

          <div>
            <label className="mb-[5px] block text-[12px] font-medium text-text-strong" htmlFor="snip-name">
              {t('snippet.name')} <span className="text-danger">*</span>
            </label>
            <input
              id="snip-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSave) void save();
              }}
              placeholder={t('snippet.namePlaceholder')}
              maxLength={100}
              className={inputCls}
            />
          </div>

          <div>
            <label className="mb-[5px] block text-[12px] font-medium text-text-strong" htmlFor="snip-desc">
              {t('snippet.description')}
            </label>
            <input
              id="snip-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('snippet.descriptionPlaceholder')}
              maxLength={2000}
              className={inputCls}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 px-[18px] pb-[18px]">
          <button
            type="button"
            onClick={onClose}
            className="h-[34px] rounded-[6px] bg-bg-tab-active px-4 text-[12.5px] text-text-body hover:text-text-strong"
          >
            {t('snippet.cancel')}
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => void save()}
            className={
              canSave
                ? 'h-[34px] rounded-[6px] bg-accent px-4 text-[12.5px] font-medium text-white hover:bg-accent-hover'
                : 'h-[34px] cursor-not-allowed rounded-[6px] bg-accent/30 px-4 text-[12.5px] font-medium text-[#9596C6]'
            }
          >
            {t('snippet.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
