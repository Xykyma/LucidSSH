import type { DashboardAlertIssue } from '@shared/dashboard';
import { openHostsDb } from './db';

/**
 * DASH-09: «Больше не показывать» для находок health-баннера — хостовое
 * Внутреннее состояние (ADR-0014, пишет main, self-clearing в ssh/dashboard.ts).
 * Отдельная таблица, не колонка `hosts` (.scratch/host-scoped-flags-to-db):
 * поля просто нет там, откуда его можно случайно отдать в renderer вместе с
 * hostList — асимметрия с `history_enabled` (флаг-Настройка, живёт в `Host`)
 * следует из того, кто пишет, а не из нормализации.
 */

export function listDismissedAlerts(hostId: number): DashboardAlertIssue[] {
  const rows = openHostsDb()
    .prepare('SELECT issue FROM host_dismissed_alerts WHERE host_id = ?')
    .all(hostId) as Array<{ issue: DashboardAlertIssue }>;
  return rows.map((r) => r.issue);
}

/** «Больше не показывать» для одной находки — жмёт окно (config:dismiss-dashboard-alert). */
export function addDismissedAlert(hostId: number, issue: DashboardAlertIssue): void {
  openHostsDb()
    .prepare('INSERT OR IGNORE INTO host_dismissed_alerts (host_id, issue) VALUES (?, ?)')
    .run(hostId, issue);
}

/**
 * Полная замена набора мьютов хоста — используется self-clearing (`ssh/dashboard.ts`):
 * находка, переставшая проявляться, снимается сама, остальные переживают опрос.
 * Пустой список равносилен снятию всех мьютов хоста.
 */
export function replaceDismissedAlerts(hostId: number, issues: DashboardAlertIssue[]): void {
  const db = openHostsDb();
  const run = db.transaction((list: DashboardAlertIssue[]) => {
    db.prepare('DELETE FROM host_dismissed_alerts WHERE host_id = ?').run(hostId);
    const insert = db.prepare('INSERT INTO host_dismissed_alerts (host_id, issue) VALUES (?, ?)');
    for (const issue of list) insert.run(hostId, issue);
  });
  run(issues);
}
