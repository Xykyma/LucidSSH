import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { DashboardAlert, DashboardAlertIssue, DashboardMetrics } from '@shared/dashboard';
import { Icon } from '@/components/common/Icon';

/**
 * Одноразовый health-баннер дашборда (DASH-09): показывается после первого
 * успешного опроса, если превышен красный порог метрики (DASH-03) или найден
 * reboot-required. Независим от видимости мини-дашборда (DASH-04) — main шлёт
 * событие максимум один раз за сессию (см. src/main/ssh/dashboard.ts),
 * поэтому после закрытия (×) баннер не появляется повторно.
 */

function issueText(
  t: (key: string, opts?: Record<string, unknown>) => string,
  issue: DashboardAlertIssue,
  metrics: DashboardMetrics | undefined
): string {
  switch (issue) {
    case 'cpu':
      return t('dashboard.healthBanner.cpu', { value: metrics?.cpuPercent ?? '—' });
    case 'ram': {
      const value =
        metrics?.ramUsedMb != null && metrics.ramTotalMb
          ? Math.round((metrics.ramUsedMb / metrics.ramTotalMb) * 100)
          : '—';
      return t('dashboard.healthBanner.ram', { value });
    }
    case 'disk':
      return t('dashboard.healthBanner.disk', { value: metrics?.diskPercent ?? '—' });
    case 'rebootRequired':
      return t('dashboard.healthBanner.rebootRequired');
  }
}

export function DashboardHealthBanner({
  alert,
  metrics,
  onClose,
  onDismissIssue
}: {
  alert: DashboardAlert;
  metrics: DashboardMetrics | undefined;
  onClose: () => void;
  /** «Больше не показывать» для одной находки — не ждёт следующего reconnect
   *  (DASH-09). undefined — Quick Connect (HM-11): персистентной настройке
   *  негде жить у сессии без хоста, кнопка скрывается, крестик остаётся. */
  onDismissIssue: ((issue: DashboardAlertIssue) => void) | undefined;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-[9px] border-b border-l-[3px] border-b-border-default border-l-danger bg-bg-elevated px-4 py-[10px]"
    >
      <span className="mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full bg-danger text-[12px] font-bold text-white">
        !
      </span>
      <ul className="min-w-0 flex-1 text-[12.5px] leading-[1.5] text-danger-text">
        {alert.issues.map((issue) => (
          <li key={issue} className="flex items-center gap-2">
            <span className="min-w-0 flex-1">{issueText(t, issue, metrics)}</span>
            {onDismissIssue && (
              <button
                type="button"
                onClick={() => onDismissIssue(issue)}
                className="shrink-0 text-[11.5px] text-text-muted underline hover:text-text-strong"
              >
                {t('dashboard.healthBanner.dismissIssue')}
              </button>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        aria-label={t('common.close')}
        onClick={onClose}
        className="flex size-[22px] shrink-0 items-center justify-center rounded-[4px] text-text-muted hover:bg-[rgba(255,255,255,0.08)] hover:text-text-strong"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
