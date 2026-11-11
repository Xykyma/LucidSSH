import type { JSX } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/common/Icon';

/**
 * NFR-05 (тикет 06): одно блокирующее предупреждение о границах переносимого
 * профиля. Показывается до обычного UI и welcome-экрана; закрывается только
 * кнопкой «Понятно» после успешной записи отметки в main — при ошибке записи
 * предупреждение остаётся и показывает локализованную ошибку.
 */
export function PortableWarningModal({ onClose }: { onClose: () => void }): JSX.Element {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  const confirm = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setError(false);
    try {
      await window.lucidSSH.confirmPortableWarning();
      onClose();
    } catch {
      setError(true);
      setSaving(false);
    }
  };

  return (
    <div
      className="animate-[esh-fade_.15s_ease] fixed inset-0 z-[60] flex items-center justify-center bg-black/70"
      role="presentation"
    >
      <div
        className="animate-[esh-pop_.16s_ease] w-[480px] max-w-[92%] rounded-[6px] border border-border-strong bg-bg-elevated shadow-[0_24px_60px_rgba(0,0,0,0.5)]"
        role="dialog"
        aria-modal="true"
        aria-label={t('portableWarning.title')}
      >
        <div className="flex items-start gap-[10px] px-5 pt-4">
          <Icon name="alert" size={17} className="mt-[2px] shrink-0 text-warning" />
          <h2 className="text-[15px] font-semibold text-text-primary">
            {t('portableWarning.title')}
          </h2>
        </div>
        <p className="px-5 pt-3 pb-4 text-[13px] leading-[1.65] text-text-body">
          {t('portableWarning.body')}
        </p>
        {error && (
          <p className="mx-5 mb-3 rounded-[5px] border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
            {t('portableWarning.error')}
          </p>
        )}
        <div className="flex justify-end border-t border-border-default px-5 py-3">
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={saving}
            className="flex h-[34px] items-center justify-center rounded-[7px] bg-accent px-[22px] text-[13px] font-semibold text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {t('portableWarning.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
