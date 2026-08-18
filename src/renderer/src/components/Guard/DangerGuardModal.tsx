import type { JSX } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DangerousCommandPrompt } from '@shared/guard';
import { useBackdropClose } from '@/hooks/useBackdropClose';

/**
 * Модалка Стража (GUARD-02, GUARD-03; скриншот 05-Danger).
 * Красный верхний border, реальная команда с целью, поле type-to-confirm.
 * Кнопка подтверждения активна только когда введённый текст точно совпадает
 * с именем объекта (или словом подтверждения, локализованным в main).
 *
 * Опасных фрагментов в строке может быть несколько: тогда показываются ВСЕ
 * уничтожаемые объекты (иначе строка про один объект заявляла бы полноту,
 * которой нет), а набрать просят один — выбранный жребием в main
 * (.scratch/guard-multi-fragment-confirm/spec.md). Поле ввода остаётся одно.
 */
export function DangerGuardModal({
  prompt,
  onConfirm,
  onCancel
}: {
  prompt: DangerousCommandPrompt;
  onConfirm: (text: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const [value, setValue] = useState('');

  const isWord = prompt.confirmationKind === 'word';
  const manyTargets = prompt.targets.length > 1;
  const promptLabel = isWord
    ? t('guard.confirmPrompt.word', { word: prompt.confirmationText })
    : manyTargets
      ? t('guard.confirmPrompt.named', {
          target: prompt.target,
          text: prompt.confirmationText
        })
      : t(`guard.confirmPrompt.${prompt.scope}`);
  // Объяснение про один объект при нескольких заявляло бы, что удаляется он один
  // (решение разработчика 2026-08-18) — перечисляем все. Перечисление строит
  // Intl.ListFormat по активному языку: разделитель и союз («и» / «and») — часть
  // языка, а не хардкод в компоненте (CLAUDE.md §5a).
  const explanation = manyTargets
    ? t('guard.explain.multi', {
        targets: new Intl.ListFormat(i18n.language, {
          style: 'long',
          type: 'conjunction'
        }).format(prompt.targets)
      })
    : t([`guard.explain.${prompt.patternId}`, 'guard.explain.generic'], {
        target: prompt.target
      });
  const confirmLabel =
    prompt.patternId === 'rm-recursive' ? t('guard.confirmDelete') : t('guard.confirmRun');
  const matched = value === prompt.confirmationText;
  const backdrop = useBackdropClose(onCancel);

  return (
    <div
      className="animate-[esh-fade_.15s_ease] fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      {...backdrop}
      role="presentation"
    >
      <div
        className="animate-[esh-pop_.16s_ease] w-[480px] max-w-[92%] overflow-hidden rounded-[6px] border-t-4 border-t-danger bg-bg-elevated shadow-[0_24px_60px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('guard.title')}
      >
        <div className="flex items-center gap-[10px] px-[18px] pt-4 pb-3">
          <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-danger text-[14px] font-bold text-white">
            !
          </span>
          <span className="text-[16px] font-semibold text-text-strong">{t('guard.title')}</span>
        </div>

        <div className="px-[18px] pb-[18px]">
          <div className="rounded-[4px] border border-danger/30 bg-bg-panel px-3 py-[10px] font-mono text-[13px] break-all text-danger-text">
            {prompt.command}
          </div>

          <p className="mt-[14px] text-[13px] leading-[1.55] text-text-body">{explanation}</p>

          <div className="mt-[14px] rounded-[4px] bg-bg-elevated-2 px-3 py-[9px] text-[12.5px] text-text-body">
            {manyTargets ? (
              <>
                <span className="text-text-muted">
                  {t('guard.targetsLabel', { count: prompt.targets.length })}
                </span>
                <ul className="mt-[6px] flex flex-col gap-[3px]">
                  {prompt.targets.map((item) => (
                    <li
                      key={item}
                      className={`font-mono break-all ${
                        item === prompt.target ? 'text-text-strong' : 'text-text-body'
                      }`}
                    >
                      {item}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <span className="text-text-muted">{t('guard.targetLabel')}</span>{' '}
                <span className="font-mono text-text-strong">{prompt.target}</span>
              </>
            )}
          </div>

          <div className="mt-4">
            <label className="mb-[7px] block text-[12.5px] text-text-body" htmlFor="guard-confirm">
              {promptLabel}
            </label>
            <input
              id="guard-confirm"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && matched) onConfirm(value);
                if (e.key === 'Escape') onCancel();
              }}
              placeholder={prompt.confirmationText}
              className="h-[34px] w-full rounded-[4px] border border-danger/40 bg-bg-panel px-[11px] font-mono text-[13px] text-text-strong outline-none placeholder:text-text-dim focus:border-danger"
            />
          </div>

          <div className="mt-[18px] flex justify-end gap-[9px]">
            <button
              type="button"
              onClick={onCancel}
              className="h-[34px] rounded-[4px] border border-[rgba(255,255,255,0.1)] bg-bg-elevated-2 px-4 text-[13px] font-medium text-text-body hover:bg-bg-tab-active"
            >
              {t('guard.cancel')}
            </button>
            <button
              type="button"
              disabled={!matched}
              onClick={() => onConfirm(value)}
              className="h-[34px] rounded-[4px] bg-danger px-4 text-[13px] font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:bg-danger/[0.16] disabled:text-[#8B5A60]"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
