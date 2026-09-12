import type { JSX } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HostKeyPrompt } from '@shared/ssh';
import { usePanels } from '@/stores/panels';

/**
 * Модалка проверки отпечатка (SSH-03/04; скриншот 04-Fingerprint).
 * Первое подключение: fingerprint + «Подтвердить и подключиться».
 * Смена ключа: danger-вариант, кнопка активна только после явного
 * подтверждения проверки через независимый источник (SSH-04).
 *
 * Намеренно вне стека Esc (ADR-0010): единственный оверлей, который не зовёт
 * useBackdropClose — его нельзя закрыть ничем, кроме явного «принять»/
 * «отклонить», решение уже было в коде. Приглашение доверять ключу хоста не
 * должно закрываться рефлекторной клавишей; «промолчал» не является ответом.
 * Не добавляйте сюда useEscapeClose.
 */
export function FingerprintModal({
  prompt,
  onAnswer
}: {
  prompt: HostKeyPrompt;
  onAnswer: (decision: 'accept' | 'reject') => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { openHelp } = usePanels();
  const [copied, setCopied] = useState(false);
  const [acked, setAcked] = useState(false);
  const [fpHelpOpen, setFpHelpOpen] = useState(false);

  const copy = (): void => {
    window.lucidSSH.clipboardWrite(prompt.fingerprintSha256);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const changed = prompt.isChanged;
  // 'test' (кнопка «Проверить соединение», ADR-0016 PR-2) не открывает
  // Сессию после accept — «…и подключиться» в подписи кнопки было бы неправдой.
  const confirmKey =
    prompt.purpose === 'test'
      ? changed
        ? 'fp.confirmChangedTest'
        : 'fp.confirmTest'
      : changed
        ? 'fp.confirmChanged'
        : 'fp.confirm';

  return (
    <div
      className="animate-[esh-fade_.15s_ease] fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      role="presentation"
    >
      <div
        className={`animate-[esh-pop_.16s_ease] w-[440px] max-w-[92%] rounded-[6px] border bg-bg-elevated shadow-[0_24px_60px_rgba(0,0,0,0.5)] ${
          changed ? 'border-danger/40 border-t-2 border-t-danger' : 'border-border-strong'
        }`}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-[18px] pt-4 text-[16px] font-semibold text-text-strong">
          {changed ? t('fp.titleChanged') : t('fp.titleFirst')}
        </div>
        <div className="px-[18px] pt-3 text-[13px] leading-[1.55] text-text-body">
          {changed
            ? t('fp.bodyChanged', { host: `${prompt.hostName} (${prompt.address})` })
            : t('fp.bodyFirst')}
        </div>

        {!changed && (
          <div className="px-[18px] pt-[10px]">
            <button
              type="button"
              onClick={() => setFpHelpOpen((v) => !v)}
              className="text-[12px] text-lavender-light underline-offset-2 hover:text-[#A5B4FC] hover:underline"
            >
              {t('fp.whereToFind')} {fpHelpOpen ? '▴' : '▾'}
            </button>
            {fpHelpOpen && (
              <div className="animate-[esh-fade_.14s_ease] mt-[8px] rounded-[4px] border border-[rgba(255,255,255,0.1)] bg-bg-panel px-3 py-[10px]">
                <p className="text-[12px] leading-[1.55] text-text-muted">
                  {t('fp.whereToFindText')}
                </p>
                <button
                  type="button"
                  onClick={() => openHelp({ tab: 'start', anchor: 'fingerprint-help' })}
                  className="mt-[8px] text-[12px] text-lavender-light underline-offset-2 hover:text-[#A5B4FC] hover:underline"
                >
                  {t('fp.whereToFindMore')}
                </button>
              </div>
            )}
          </div>
        )}

        {changed && prompt.previousFingerprint && (
          <div className="mx-[18px] mt-[14px] rounded-[4px] border border-[rgba(255,255,255,0.1)] bg-bg-panel px-3 py-[10px]">
            <div className="text-[10.5px] font-semibold text-text-dim uppercase">
              {t('fp.previous')}
            </div>
            <div className="mt-1 font-mono text-[12.5px] break-all text-text-muted">
              {prompt.previousFingerprint}
            </div>
          </div>
        )}

        <div
          className={`mx-[18px] mt-[14px] flex items-center gap-2 rounded-[4px] border px-3 py-[10px] ${
            changed ? 'border-danger/30 bg-danger/5' : 'border-[rgba(255,255,255,0.1)] bg-bg-panel'
          }`}
        >
          <div className="min-w-0 flex-1">
            {changed && (
              <div className="mb-1 text-[10.5px] font-semibold text-text-dim uppercase">
                {t('fp.current')}
              </div>
            )}
            <div
              className={`font-mono text-[12.5px] break-all ${changed ? 'text-warning-text' : 'text-success-bright'}`}
            >
              {prompt.fingerprintSha256}
            </div>
          </div>
          <button
            type="button"
            onClick={copy}
            className="h-[26px] shrink-0 rounded-[4px] border border-[rgba(255,255,255,0.1)] bg-bg-elevated-2 px-[10px] text-[11.5px] text-text-body hover:border-accent hover:text-text-strong"
          >
            {copied ? t('fp.copied') : t('fp.copy')}
          </button>
        </div>

        {!changed && (
          <div className="px-[18px] pt-[10px] text-[11.5px] leading-[1.5] text-text-muted">
            {t('fp.explain')}
          </div>
        )}

        {changed && (
          <label className="mx-[18px] mt-[14px] flex cursor-pointer items-start gap-2 text-[12px] text-text-body">
            <input
              type="checkbox"
              checked={acked}
              onChange={(e) => setAcked(e.target.checked)}
              className="mt-[2px] accent-[#EF4444]"
            />
            {t('fp.ackChanged')}
          </label>
        )}

        <div className="flex justify-end gap-[9px] px-[18px] py-[18px]">
          <button
            type="button"
            onClick={() => onAnswer('reject')}
            className="h-[34px] rounded-[4px] border border-[rgba(255,255,255,0.1)] bg-bg-elevated-2 px-4 text-[13px] font-medium text-text-body hover:bg-bg-tab-active"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={changed && !acked}
            onClick={() => onAnswer('accept')}
            className={
              changed
                ? 'h-[34px] rounded-[4px] bg-danger px-4 text-[13px] font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40'
                : 'h-[34px] rounded-[4px] bg-accent px-4 text-[13px] font-semibold text-white hover:bg-accent-hover'
            }
          >
            {t(confirmKey)}
          </button>
        </div>
      </div>
    </div>
  );
}
