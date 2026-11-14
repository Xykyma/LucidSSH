import type { DashboardAlert, DashboardAlertIssue } from '@shared/dashboard';

/**
 * Тикет 02: различие временно скрытой, окончательно снятой и закрытой
 * пользователем находки health-баннера (DASH-09/10). main присылает видимый
 * набор находок Соединения по каждому изменению (восстановление метрики,
 * временное скрытие по null); крестик и «Больше не показывать» закрывают
 * находку до конца текущего Соединения — повторное событие от main её не
 * воскрешает. Граница Соединения (подключение/переподключение) сбрасывает
 * оба списка — решает вызывающий код по статусу сессии.
 */

/** Новое событие от main: пустой набор — уведомления сняты целиком. */
export function alertAfterEvent(issues: DashboardAlertIssue[]): DashboardAlert | undefined {
  return issues.length > 0 ? { issues } : undefined;
}

/** Крестик/мьют: находка закрыта до следующего Соединения. */
export function closedAfterDismiss(
  prev: DashboardAlertIssue[] | undefined,
  issue: DashboardAlertIssue
): DashboardAlertIssue[] {
  if (prev?.includes(issue)) return prev;
  return [...(prev ?? []), issue];
}

/** Набор для показа: видимый от main минус закрытые пользователем. */
export function visibleAlertIssues(
  alert: DashboardAlert | undefined,
  closed: DashboardAlertIssue[] | undefined
): DashboardAlertIssue[] {
  return alert?.issues.filter((issue) => !closed?.includes(issue)) ?? [];
}
