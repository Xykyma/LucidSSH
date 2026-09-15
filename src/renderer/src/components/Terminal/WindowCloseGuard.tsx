import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@/stores/config';
import { usePanels } from '@/stores/panels';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { TmuxHintLink } from '@/components/Terminal/TmuxHintLink';

/**
 * WIN-02: при закрытии окна с активными сессиями main блокирует закрытие и
 * присылает событие; здесь показываем подтверждение и, при согласии, даём
 * команду принудительного закрытия. WIN-04: если хоть одна активная сессия
 * сейчас выполняет команду, диалог дополнительно перечисляет эти сессии
 * (хост: команда) и предупреждает о прерывании со ссылкой на карточку tmux.
 */
export function WindowCloseGuard(): JSX.Element | null {
  const { t } = useTranslation();
  const { update } = useConfig();
  const { openCatalogRequest } = usePanels();
  const [activeCount, setActiveCount] = useState<number | null>(null);
  const [busySessions, setBusySessions] = useState<Array<{ hostName: string; command: string }>>(
    []
  );

  useEffect(() => {
    return window.lucidSSH.onConfirmWindowClose((count, busy) => {
      setActiveCount(count);
      setBusySessions(busy);
    });
  }, []);

  if (activeCount === null) return null;

  const close = (): void => {
    setActiveCount(null);
    setBusySessions([]);
  };

  return (
    <ConfirmDialog
      title={t('tabs.windowCloseConfirm.title')}
      confirmLabel={t('tabs.windowCloseConfirm.confirm')}
      danger
      onConfirm={() => {
        close();
        window.lucidSSH.windowConfirmClose();
      }}
      onCancel={close}
    >
      <p>{t('tabs.windowCloseConfirm.body', { count: activeCount })}</p>
      {busySessions.length > 0 && (
        <>
          <p className="mt-2">{t('tabs.windowCloseConfirm.commandRunningIntro')}</p>
          <ul className="mt-1 list-disc space-y-[2px] pl-4">
            {busySessions.map((s, i) => (
              <li key={i}>
                {s.hostName}: <span className="font-mono text-text-strong">{s.command}</span>
              </li>
            ))}
          </ul>
          <TmuxHintLink
            onOpen={() => {
              void update('ui.catalogPanelOpen', true);
              openCatalogRequest({ tab: 'catalog', query: 'tmux' });
              close();
            }}
          />
        </>
      )}
    </ConfirmDialog>
  );
}
