import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useBackdropClose } from '@/hooks/useBackdropClose';
import { useEscapeClose } from '@/hooks/useEscapeClose';
import { ControlText, hasControlChars } from '@/components/Guard/ControlText';

/**
 * Предпросмотр многострочной вставки (TERM-05, §14 гайда): пользователь видит
 * весь текст и подтверждает отправку; Enter не имитируется без подтверждения.
 * Подсветка опасных строк — предварительная эвристика; окончательное решение
 * принимает Страж в main process (Этап 4, GUARD-02).
 */

// Лёгкая эвристика для подсветки в предпросмотре (не заменяет Стража).
const DANGER_HINT = /\b(rm\s+-[rf]|mkfs|dd\s+if=|:\(\)\{|chmod\s+-R\s+777|>\s*\/dev\/)/i;

export function PastePreviewDialog({
  text,
  onConfirm,
  onCancel
}: {
  text: string;
  onConfirm: (text: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const hasDanger = lines.some((l) => DANGER_HINT.test(l));
  const hasControl = hasControlChars(text);

  const backdrop = useBackdropClose(onCancel);
  useEscapeClose('paste-preview-dialog', onCancel);

  return (
    <div
      className="animate-[esh-fade_.15s_ease] fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      {...backdrop}
      role="presentation"
    >
      <div
        className="animate-[esh-pop_.16s_ease] flex max-h-[70vh] w-[560px] max-w-[92%] flex-col rounded-[6px] border border-border-strong bg-bg-elevated shadow-[0_24px_60px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 pt-4 text-[14.5px] font-semibold text-text-strong">
          {t('paste.title')}
        </div>
        <div className="px-5 pt-2 text-[12.5px] text-text-muted">
          {t('paste.body', { count: lines.length })}
        </div>
        {hasDanger && (
          <div className="mx-5 mt-2 rounded-[6px] border border-warning/25 bg-warning/10 px-3 py-2 text-[11.5px] text-warning-text">
            {t('paste.dangerNote')}
          </div>
        )}
        {hasControl && (
          <div className="mx-5 mt-2 rounded-[6px] border border-warning/25 bg-warning/10 px-3 py-2 text-[11.5px] text-warning-text">
            {t('paste.controlNote')}
          </div>
        )}
        <div className="m-5 min-h-0 flex-1 overflow-auto rounded-[6px] border border-border-default bg-bg-base p-3 font-mono text-[11.5px]">
          {lines.map((line, i) => (
            <div
              key={i}
              className={DANGER_HINT.test(line) ? 'whitespace-pre text-danger-text' : 'whitespace-pre text-text-body'}
            >
              {line ? <ControlText text={line} /> : ' '}
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2 px-5 pb-4">
          <button
            type="button"
            onClick={onCancel}
            className="h-[34px] rounded-[6px] bg-bg-tab-active px-4 text-[12.5px] text-text-body hover:text-text-strong"
          >
            {t('paste.cancel')}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(text)}
            className="h-[34px] rounded-[6px] bg-accent px-4 text-[12.5px] font-medium text-white hover:bg-accent-hover"
          >
            {t('paste.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
