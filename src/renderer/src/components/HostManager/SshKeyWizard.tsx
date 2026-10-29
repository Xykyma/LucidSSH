import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PASSPHRASE_MIN } from '@shared/keygen';
import { Icon } from '@/components/common/Icon';
import { useBackdropClose } from '@/hooks/useBackdropClose';
import { useEscapeClose } from '@/hooks/useEscapeClose';
import { isWindows } from '@/hooks/platform';

/**
 * Мастер создания SSH-ключа (HM-12), открывается из NewConnectionDrawer
 * кнопкой «Создать новый ключ». Четыре шага: генерация Ed25519 системным
 * ssh-keygen → passphrase (опционально) → показ публичного ключа →
 * объяснение автодозаписи на сервер. Закрытие в любой момент оставляет уже
 * созданный файл ключа на диске (без вопросов об удалении). Форма хоста
 * получает путь к ключу сразу после шага 1 (onGenerated), passphrase уходит
 * в поле секрета формы (onPassphraseSaved) и сохраняется через keytar тем же
 * путём, что у существующих ключей.
 */

interface WizardForm {
  name: string;
  address: string;
  port: string;
  username: string;
}

export function SshKeyWizard({
  form,
  onGenerated,
  onPassphraseSaved,
  onClose
}: {
  form: WizardForm;
  onGenerated: (keyPath: string) => void;
  onPassphraseSaved: (passphrase: string) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [keygenMissing, setKeygenMissing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState(false);
  const [keyPath, setKeyPath] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [applyingPass, setApplyingPass] = useState(false);
  const [passError, setPassError] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.lucidSSH.keygenAvailable().then((available) => {
      if (!cancelled && !available) setKeygenMissing(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Мастер регистрируется в стеке позже drawer'а (монтируется по клику внутри
  // уже открытого NewConnectionDrawer) — LIFO сам кладёт его выше, без
  // ручного capture/stopPropagation, которые были нужны старому механизму.
  useEscapeClose('ssh-key-wizard', onClose);

  const generate = async (): Promise<void> => {
    if (generating) return;
    setGenerating(true);
    setGenError(false);
    try {
      const res = await window.lucidSSH.keygenGenerate({
        name: form.name,
        address: form.address,
        port: Number(form.port) >= 1 && Number(form.port) <= 65535 ? Number(form.port) : 22,
        username: form.username
      });
      if (!res.ok) {
        if (res.reason === 'keygen-missing') setKeygenMissing(true);
        else setGenError(true);
        return;
      }
      setKeyPath(res.keyPath);
      setPublicKey(res.publicKey);
      // Конец шага 1: форма хоста сразу переключается на новый ключ,
      // независимо от того, дойдёт ли пользователь до конца мастера
      onGenerated(res.keyPath);
      setStep(2);
    } catch {
      setGenError(true);
    } finally {
      setGenerating(false);
    }
  };

  const applyPassphrase = async (): Promise<void> => {
    if (applyingPass || passphrase.length < PASSPHRASE_MIN) return;
    setApplyingPass(true);
    setPassError(false);
    try {
      const res = await window.lucidSSH.keygenSetPassphrase(keyPath, passphrase);
      if (!res.ok) {
        setPassError(true);
        return;
      }
      onPassphraseSaved(passphrase);
      setStep(3);
    } catch {
      setPassError(true);
    } finally {
      setApplyingPass(false);
    }
  };

  const copyPublicKey = (): void => {
    window.lucidSSH.clipboardWrite(publicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const heading = 'text-[14.5px] font-semibold text-text-strong';
  const body = 'text-[12.5px] leading-relaxed text-text-muted';
  const primaryBtn =
    'h-[34px] rounded-[6px] bg-accent px-4 text-[12.5px] font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50';
  const secondaryBtn =
    'h-[34px] rounded-[6px] bg-bg-tab-active px-4 text-[12.5px] text-text-body hover:text-text-strong';

  return (
    <div
      className="animate-[esh-fade_.15s_ease] fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      {...useBackdropClose(onClose)}
      role="presentation"
    >
      <div
        className="animate-[esh-pop_.16s_ease] w-[440px] max-w-[92%] rounded-[6px] border border-border-strong bg-bg-elevated shadow-[0_24px_60px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('conn.keyWizard.title')}
      >
        <div className="flex items-center justify-between px-5 pt-4">
          <div className="flex items-center gap-2">
            <Icon name="key" size={16} />
            <span className={heading}>{t('conn.keyWizard.title')}</span>
          </div>
          <div className="flex items-center gap-3">
            {!keygenMissing && (
              <span className="text-[11px] text-text-dim">
                {t('conn.keyWizard.step', { current: step, total: 4 })}
              </span>
            )}
            <button
              type="button"
              aria-label={t('common.close')}
              onClick={onClose}
              className="flex size-[24px] items-center justify-center rounded-[4px] text-text-muted hover:bg-bg-elevated-2 hover:text-text-strong"
            >
              <Icon name="close" size={15} />
            </button>
          </div>
        </div>

        {keygenMissing ? (
          // ssh-keygen.exe не найден: объяснение в самом мастере, не системная ошибка
          <div className="space-y-3 px-5 py-4">
            <div className="text-[13px] font-medium text-text-strong">
              {t('conn.keyWizard.missing.title')}
            </div>
            {isWindows && <p className={body}>{t('conn.keyWizard.missing.body')}</p>}
            <p className={body}>
              {t(isWindows ?'conn.keyWizard.missing.how' : 'conn.keyWizard.missing.howLinux')}
            </p>
            <div className="flex justify-end gap-2 pt-1 pb-1">
              <button type="button" onClick={onClose} className={secondaryBtn}>
                {t('common.close')}
              </button>
              {isWindows && (
                <button
                  type="button"
                  onClick={() => window.lucidSSH.keygenOpenInstall()}
                  className={primaryBtn}
                >
                  {t('conn.keyWizard.missing.open')}
                </button>
              )}
            </div>
          </div>
        ) : step === 1 ? (
          <div className="space-y-3 px-5 py-4">
            <div className="text-[13px] font-medium text-text-strong">
              {t('conn.keyWizard.gen.title')}
            </div>
            <p className={body}>{t('conn.keyWizard.gen.body')}</p>
            <p className={body}>{t('conn.keyWizard.gen.location')}</p>
            {genError && (
              <div className="rounded-[6px] border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger-text">
                {t('conn.keyWizard.gen.error')}
              </div>
            )}
            <div className="flex justify-end pt-1 pb-1">
              <button
                type="button"
                disabled={generating}
                onClick={() => void generate()}
                className={primaryBtn}
              >
                {generating ? t('conn.keyWizard.gen.generating') : t('conn.keyWizard.gen.action')}
              </button>
            </div>
          </div>
        ) : step === 2 ? (
          <div className="space-y-3 px-5 py-4">
            <div className="text-[13px] font-medium text-text-strong">
              {t('conn.keyWizard.pass.title')}
            </div>
            <p className={body}>{t('conn.keyWizard.pass.body')}</p>
            <input
              type="password"
              className="h-[34px] w-full rounded-[4px] border border-border-default bg-bg-base px-[11px] text-[13px] text-text-strong outline-none placeholder:text-text-dim focus:border-accent"
              placeholder={t('conn.keyWizard.pass.placeholder')}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              maxLength={1024}
              autoComplete="off"
            />
            <div className="text-[11px] text-text-dim">{t('conn.keyWizard.pass.helper')}</div>
            {passError && (
              <div className="rounded-[6px] border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger-text">
                {t('conn.keyWizard.pass.error')}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1 pb-1">
              <button type="button" onClick={() => setStep(3)} className={secondaryBtn}>
                {t('conn.keyWizard.pass.skip')}
              </button>
              <button
                type="button"
                disabled={passphrase.length < PASSPHRASE_MIN || applyingPass}
                onClick={() => void applyPassphrase()}
                className={primaryBtn}
              >
                {t('conn.keyWizard.pass.setAction')}
              </button>
            </div>
          </div>
        ) : step === 3 ? (
          <div className="space-y-3 px-5 py-4">
            <div className="text-[13px] font-medium text-text-strong">
              {t('conn.keyWizard.pub.title')}
            </div>
            <p className={body}>{t('conn.keyWizard.pub.body')}</p>
            <div className="max-h-[120px] overflow-y-auto rounded-[4px] border border-border-default bg-bg-base px-3 py-2 font-mono text-[11px] break-all text-text-body select-text">
              {publicKey}
            </div>
            <div className="flex justify-between gap-2 pt-1 pb-1">
              <button
                type="button"
                onClick={copyPublicKey}
                className={`${secondaryBtn} flex items-center gap-1.5`}
              >
                <Icon name={copied ? 'check' : 'copy'} size={13} />
                {copied ? t('conn.keyWizard.pub.copied') : t('conn.keyWizard.pub.copy')}
              </button>
              <button type="button" onClick={() => setStep(4)} className={primaryBtn}>
                {t('conn.keyWizard.pub.next')}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 px-5 py-4">
            <div className="text-[13px] font-medium text-text-strong">
              {t('conn.keyWizard.install.title')}
            </div>
            <p className={body}>{t('conn.keyWizard.install.body')}</p>
            <p className={body}>{t('conn.keyWizard.install.note')}</p>
            <div className="flex justify-end pt-1 pb-1">
              <button type="button" onClick={onClose} className={primaryBtn}>
                {t('conn.keyWizard.install.done')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
