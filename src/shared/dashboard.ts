/**
 * Метрики мини-дашборда и полной модалки «Дашборд сервера» (DASH-01…05,
 * Data_Structures §7.1). null → «—» без ошибки (DASH-05). Значения парсятся
 * как данные, не исполняются.
 */
export interface DashboardProcess {
  pid: number;
  user: string;
  cmd: string;
  cpuPercent: number;
  memPercent: number;
}

export interface DashboardMetrics {
  cpuPercent: number | null;
  ramUsedMb: number | null;
  ramTotalMb: number | null;
  diskPercent: number | null;
  uptimeSeconds: number | null;
  loadAvg1: number | null;
  loadAvg5: number | null;
  loadAvg15: number | null;
  netUpKbps: number | null;
  netDownKbps: number | null;
  /** Пинг (TERM-08) — время открытия exec-канала опроса дашборда, мс. */
  pingMs: number | null;
  /** Топ по CPU, до 5 строк (пусто, если ps недоступен или сервер недоступен). */
  topProcesses: DashboardProcess[];
}

export const EMPTY_METRICS: DashboardMetrics = {
  cpuPercent: null,
  ramUsedMb: null,
  ramTotalMb: null,
  diskPercent: null,
  uptimeSeconds: null,
  loadAvg1: null,
  loadAvg5: null,
  loadAvg15: null,
  netUpKbps: null,
  netDownKbps: null,
  pingMs: null,
  topProcesses: []
};

/** DASH-09: красный порог тревоги, общий для CPU/RAM/Disk (DASH-03). */
export const DASH_RED_THRESHOLD_PERCENT = 90;

/** DASH-09/тикет 02: находки health-баннера одного Соединения (per-Connection,
 *  на Сессию renderer'а их может прийти несколько — при изменении видимости). */
export type DashboardAlertIssue = 'cpu' | 'ram' | 'disk' | 'rebootRequired';

/** Полный список известных находок — используется для валидации входных данных. */
export const DASHBOARD_ALERT_ISSUES: readonly DashboardAlertIssue[] = [
  'cpu',
  'ram',
  'disk',
  'rebootRequired'
];

export interface DashboardAlert {
  issues: DashboardAlertIssue[];
}
