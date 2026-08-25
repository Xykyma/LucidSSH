import type { JSX } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ErrorExplanation } from '@shared/content';
import { applyCommandSuggestion } from '@shared/fuzzyMatch';
import { Icon } from '@/components/common/Icon';
import { insertIntoComposer } from '@/stores/composerBus';
import { useEscapeClose } from '@/hooks/useEscapeClose';
import { useAppVersion } from '@/hooks/useAppVersion';

/**
 * Панель детектора ошибок (ERR-03; скриншот 02-Error). Выезжает снизу области
 * терминала, левый border 3px danger, не перекрывает строку ввода. Закрытие по
 * Esc или ×. Нумерованные шаги «что проверить» с копированием/вставкой команды.
 */
export function ErrorDetector({
  sessionId,
  explanation,
  onClose
}: {
  sessionId: string;
  explanation: ErrorExplanation;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [questionCopied, setQuestionCopied] = useState(false);
  const version = useAppVersion();

  void sessionId;

  // Esc должен закрывать панель независимо от фокуса — обычно он у терминала
  // (xterm), а не у самой панели (ADR-0010: панель не позиционирована, но
  // всё равно Оверлей — критерий членства в стеке транзиентность, не способ
  // позиционирования).
  useEscapeClose('error-detector', onClose);

  const copy = (cmd: string, idx: number): void => {
    window.lucidSSH.clipboardWrite(cmd);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1200);
  };

  // ERR-08: command/stderr в explanation уже замаскированы (maskSecrets, см. detector.ts
  // и sessionManager.ts) — дистрибутив сервера в блок не включается (не реализован в 1.0).
  const copyForQuestion = (): void => {
    const text = t('questionBlock.template', {
      command: explanation.command,
      exitCode: explanation.exitCode !== undefined ? String(explanation.exitCode) : '—',
      output: explanation.stderr && explanation.stderr.trim() ? explanation.stderr : '—',
      version: version || '—'
    });
    window.lucidSSH.clipboardWrite(text);
    setQuestionCopied(true);
    setTimeout(() => setQuestionCopied(false), 1200);
  };

  return (
    <div
      className="animate-[esh-slideup_.2s_ease] flex max-h-[212px] shrink-0 flex-col border-t border-l-[3px] border-t-[rgba(255,255,255,0.1)] border-l-danger bg-bg-elevated"
      role="region"
      aria-label={explanation.title}
    >
      <div className="flex shrink-0 items-center gap-[9px] px-4 pt-[13px]">
        <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-danger text-[12px] font-bold text-white">
          !
        </span>
        <span className="flex-1 text-[13px] font-semibold text-danger-text">
          {explanation.title}
        </span>
        <button
          type="button"
          title={t('errDetector.copyForQuestion')}
          aria-label={t('errDetector.copyForQuestion')}
          onClick={copyForQuestion}
          className="flex size-[22px] shrink-0 items-center justify-center rounded-[4px] text-text-muted hover:bg-[rgba(255,255,255,0.08)] hover:text-text-strong"
        >
          <Icon name={questionCopied ? 'check' : 'clipboard'} size={14} />
        </button>
        <button
          type="button"
          aria-label={t('errDetector.close')}
          onClick={onClose}
          className="flex size-[22px] shrink-0 items-center justify-center rounded-[4px] text-text-muted hover:bg-[rgba(255,255,255,0.08)] hover:text-text-strong"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-[13px]">
        {explanation.command && (
          <div className="mt-[9px] rounded-[4px] bg-bg-panel px-[10px] py-[6px] font-mono text-[12px] text-text-muted">
            {explanation.command}
          </div>
        )}
        <p className="mt-[10px] text-[12.5px] leading-[1.55] text-text-body">
          {explanation.explanation}
        </p>

        {explanation.suggestions && explanation.suggestions.length > 0 && (
          <div className="mt-[10px] flex flex-wrap items-center gap-[7px] text-[12.5px] text-text-body">
            <span>{t('errDetector.didYouMean')}</span>
            {explanation.suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                title={t('errDetector.insertSuggestion')}
                onClick={() => insertIntoComposer(applyCommandSuggestion(explanation.command, suggestion))}
                className="rounded-[4px] border border-border-strong bg-bg-panel px-[8px] py-[3px] font-mono font-semibold text-lavender hover:border-accent hover:underline"
              >
                {suggestion}
              </button>
            ))}
            <span>?</span>
          </div>
        )}

        {explanation.checks.length > 0 && (
          <>
            <div className="mt-[13px] mb-2 text-[11px] font-semibold tracking-[0.04em] text-text-muted uppercase">
              {t('errDetector.whatToCheck')}
            </div>
            <ol className="flex flex-col gap-[7px]">
              {explanation.checks.map((check, i) => (
                <li key={i} className="flex items-center gap-[9px]">
                  <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-bg-elevated-2 text-[11px] font-semibold text-text-muted">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 text-[12px] text-text-body">
                    {check.text}
                    {check.command && (
                      <span className="ml-1 rounded-[4px] bg-bg-panel px-[6px] py-px font-mono text-text-strong">
                        {check.command}
                      </span>
                    )}
                  </span>
                  {check.command && (
                    <button
                      type="button"
                      title={t('errDetector.copy')}
                      aria-label={t('errDetector.copy')}
                      onClick={() => copy(check.command!, i)}
                      className="flex size-[24px] shrink-0 items-center justify-center rounded-[4px] text-text-muted hover:bg-bg-elevated-2 hover:text-text-strong"
                    >
                      <Icon name={copiedIdx === i ? 'check' : 'copy'} size={13} />
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}
