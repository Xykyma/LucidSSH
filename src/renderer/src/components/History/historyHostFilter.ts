/**
 * Фильтр по хосту в панели истории и цель кнопки «Очистить» (HIST-08).
 *
 * Все сессии Быстрого подключения (HM-11) пишутся в историю под одним
 * host_id=0 — строки в `hosts` у них нет, а разные серверы неотличимы. Поэтому
 * этот id — не «хост»: его чип подписан «Быстрое подключение», а очистка по
 * нему удаляет историю всех быстрых подключений и прямо так и называется.
 */

export const QUICK_CONNECT_HOST_ID = 0;

export type HostFilter = number | 'all' | 'session';

export type ClearTarget =
  | { kind: 'all' }
  | { kind: 'host'; hostId: number }
  | { kind: 'quickConnect'; hostId: typeof QUICK_CONNECT_HOST_ID }
  /** Выбрана «Эта сессия», но активной сессии уже нет (закрылась при открытом дровере). */
  | { kind: 'stale' };

export function resolveClearTarget(filter: HostFilter, activeHostId: number | undefined): ClearTarget {
  if (filter === 'all') return { kind: 'all' };
  const hostId = filter === 'session' ? activeHostId : filter;
  if (hostId === undefined) return { kind: 'stale' };
  return hostId === QUICK_CONNECT_HOST_ID
    ? { kind: 'quickConnect', hostId: QUICK_CONNECT_HOST_ID }
    : { kind: 'host', hostId };
}

/**
 * Чип «Эта сессия» у Быстрого подключения не показывается: отфильтровать одну
 * такую сессию нельзя, а «все быстрые подключения» уже есть отдельным чипом.
 */
export function showsSessionChip(activeHostId: number | undefined): boolean {
  return activeHostId !== undefined && activeHostId !== QUICK_CONNECT_HOST_ID;
}
