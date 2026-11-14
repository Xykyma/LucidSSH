import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { DashboardAlert, DashboardAlertIssue, DashboardMetrics } from '@shared/dashboard';
import { Icon } from '@/components/common/Icon';

/**
 * Одноразовые health-уведомления дашборда (DASH-09, тикет 02): показываются
 * после первого успешного опроса, если превышен красный порог метрики (DASH-03)
 * или найден reboot-required; восстановившаяся метрика (<90%) исчезает сама, по
 * null временно скрывается, повторный рост в том же Соединении уведомление не
 * создаёт. Независимы от видимости мини-дашборда (DASH-04) — main шлёт событие
 * при каждом изменении видимого набора (см. src/main/ssh/dashboard.ts); каждый
 * крестик скрывает только свою находку, не создавая персистентный мьют (DASH-10).
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
  onCloseIssue,
  onDismissIssue
}: {
  alert: DashboardAlert;
  metrics: DashboardMetrics | undefined;
  onCloseIssue: (issue: DashboardAlertIssue) => void;
  /** «Больше не показывать» для одной находки — не ждёт следующего reconnect
   *  (DASH-10). undefined — Quick Connect (HM-11): персистентной настройке
   *  негде жить у сессии без хоста, кнопка скрывается, крестик остаётся. */
  onDismissIssue: ((issue: DashboardAlertIssue) => void) | undefined;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-border-default bg-bg-terminal p-2">
      {alert.issues.map((issue) => (
        <div
          role="alert"
          key={issue}
          className="flex items-start gap-[9px] border border-l-[3px] border-border-default border-l-danger bg-bg-elevated px-4 py-[10px]"
        >
          <span className="mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full bg-danger text-[12px] font-bold text-white">
            !
          </span>
          <span className="min-w-0 flex-1 text-[12.5px] leading-[1.5] text-danger-text">
            {issueText(t, issue, metrics)}
          </span>
          {onDismissIssue && (
            <button
              type="button"
              onClick={() => onDismissIssue(issue)}
              className="shrink-0 text-[11.5px] text-text-muted underline hover:text-text-strong"
            >
              {t('dashboard.healthBanner.dismissIssue')}
            </button>
          )}
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={() => onCloseIssue(issue)}
            className="flex size-[22px] shrink-0 items-center justify-center rounded-[4px] text-text-muted hover:bg-[rgba(255,255,255,0.08)] hover:text-text-strong"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
