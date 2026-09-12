import { IPC } from '@shared/ipc';
import type { Connection } from './connection';
import {
  DASH_RED_THRESHOLD_PERCENT,
  EMPTY_METRICS,
  type DashboardAlert,
  type DashboardAlertIssue,
  type DashboardMetrics
} from '@shared/dashboard';
import { emit } from '../ipc/events';
import { listDismissedAlerts, replaceDismissedAlerts } from '../hosts/dashboardMutes';

/** Логгер в лог соединения сессии (передаёт sessionManager, чтобы не плодить цикл импортов). */
export type DashboardLogger = (messageKey: string, params?: Record<string, string | number>) => void;

/**
 * Мини-дашборд сервера (DASH-01…05, §19 Security_Guide).
 * Отдельный SSH exec-канал (НЕ основная сессия), заранее заданный набор команд,
 * интервал 10 с. Метрики парсятся как данные и не исполняются. Недоступность
 * канала → «—» без ошибки в UI (DASH-05).
 */

const INTERVAL_MS = 10_000;
const EXEC_TIMEOUT_MS = 8_000;

/**
 * Фиксированная POSIX-sh команда сбора метрик. Печатает строки key value.
 * Не содержит недоверенного ввода — статическая строка (§19 гайда).
 */
const METRICS_COMMAND = [
  // CPU % и сеть: делят один и тот же замер с паузой 0.4с (два снимка /proc/stat
  // и /proc/net/dev, дельта за интервал), чтобы не удлинять общий опрос.
  // `rest` обязателен: в /proc/stat 10 полей (…steal guest guest_nice), без него
  // последняя переменная забирает остаток строки («N 0 0»), арифметика $(( ))
  // падает с syntax error, а ошибка расширения ФАТАЛЬНА для неинтерактивного
  // bash — умирала вся команда, и дашборд всегда показывал «—» (найдено 07.07.2026).
  'read cpu a b c d e f g h rest < /proc/stat 2>/dev/null; t1=$((a+b+c+d+e+f+g+h)); id1=$d;',
  // Сумма rx/tx по всем интерфейсам кроме lo. FS=[: ]+ убирает двоеточие после
  // имени интерфейса без gsub — не нужно экранировать кавычки внутри JS-строки.
  "netv1=$(awk -F'[: ]+' 'NR>2 && $2!=\"lo\"{rx+=$3;tx+=$11} END{print rx+0,tx+0}' /proc/net/dev 2>/dev/null); set -- $netv1; rx1=$1; tx1=$2;",
  'sleep 0.4;',
  'read cpu a b c d e f g h rest < /proc/stat 2>/dev/null; t2=$((a+b+c+d+e+f+g+h)); id2=$d;',
  "netv2=$(awk -F'[: ]+' 'NR>2 && $2!=\"lo\"{rx+=$3;tx+=$11} END{print rx+0,tx+0}' /proc/net/dev 2>/dev/null); set -- $netv2; rx2=$1; tx2=$2;",
  'dt=$((t2-t1)); di=$((id2-id1));',
  'if [ "$dt" -gt 0 ] 2>/dev/null; then echo "CPU $(( (100*(dt-di))/dt ))"; fi;',
  // KB/s: делители нецелые (0.4с, 1024) — считаем в awk, не в bash-арифметике.
  'awk -v rx1="$rx1" -v tx1="$tx1" -v rx2="$rx2" -v tx2="$tx2" \'BEGIN{d1=tx2-tx1; d2=rx2-rx1; if(d1<0)d1=0; if(d2<0)d2=0; printf "NET %.1f %.1f\\n", d1/0.4/1024, d2/0.4/1024}\';',
  // RAM: total и available (fallback MemFree) в МБ
  'mt=$(awk "/^MemTotal:/{print \\$2}" /proc/meminfo 2>/dev/null);',
  'ma=$(awk "/^MemAvailable:/{print \\$2}" /proc/meminfo 2>/dev/null);',
  '[ -z "$ma" ] && ma=$(awk "/^MemFree:/{print \\$2}" /proc/meminfo 2>/dev/null);',
  '[ -n "$mt" ] && [ -n "$ma" ] && echo "RAM $(( (mt-ma)/1024 )) $(( mt/1024 ))";',
  // Диск по /
  'df -kP / 2>/dev/null | awk "NR==2{gsub(\\"%\\",\\"\\",\\$5); print \\"DISK \\"\\$5}";',
  // Uptime
  'awk "{print \\"UP \\"int(\\$1)}" /proc/uptime 2>/dev/null;',
  // Средняя нагрузка (1/5/15 мин)
  'awk "{print \\"LOAD \\"\\$1\\" \\"\\$2\\" \\"\\$3}" /proc/loadavg 2>/dev/null;',
  // Топ-5 процессов по CPU. comm (не полный cmdline) — без пробелов, парсинг безопасен.
  'ps -eo pid,user,comm,pcpu,pmem --no-headers 2>/dev/null | sort -k4 -rn | head -n 5 | awk "{print \\"PROC \\"\\$1\\" \\"\\$2\\" \\"\\$3\\" \\"\\$4\\" \\"\\$5}"'
].join(' ');

/**
 * DASH-09: проверка `/var/run/reboot-required` — довесок к METRICS_COMMAND того
 * же exec-канала, добавляется только пока не случился первый успешный опрос
 * (DashboardState.firstSuccessDone), дальше не повторяется и не увеличивает
 * частоту опроса (DASH-07).
 * Ведущий `;` обязателен: последняя строка METRICS_COMMAND (топ-процессы) не
 * заканчивается разделителем — без `;` шелл читает `[ -f ... ]` как ЕЩЁ ОДИН
 * аргумент предыдущего `awk` (в частности `-f <файл>` — awk принимает это за
 * «прочитать программу из файла»), reboot-check никогда не выполнялся, а awk
 * переставал читать stdin из pipe (найдено 23.07.2026 при проверке на реальных
 * серверах — баннер reboot-required никогда не появлялся).
 */
const REBOOT_CHECK_COMMAND = '; [ -f /var/run/reboot-required ] && echo "REBOOT 1";';

interface DashboardState {
  timer: NodeJS.Timeout;
  client: Pick<Connection, 'exec'>;
  hostId: number;
  running: boolean;
  logger: DashboardLogger;
  /** Причина недоступности уже записана в лог соединения — не спамим каждые 10 с. */
  problemLogged: boolean;
  /** DASH-09: решение о health-баннере уже принято (успех или нет) — после
   *  этого REBOOT_CHECK_COMMAND больше не добавляется и баннер не повторяется. */
  firstSuccessDone: boolean;
}

const dashboards = new Map<string, DashboardState>();

function send(sessionId: string, metrics: DashboardMetrics): void {
  emit(IPC.evDashboard, sessionId, metrics);
}

function sendAlert(sessionId: string, alert: DashboardAlert): void {
  if (!dashboards.has(sessionId)) return;
  emit(IPC.evDashboardAlert, sessionId, alert);
}

function parseRebootRequired(output: string): boolean {
  return /^REBOOT\b/m.test(output);
}

/** DASH-09: красные пороги (DASH-03) + reboot-required → находки для баннера. */
function computeAlertIssues(metrics: DashboardMetrics, rebootRequired: boolean): DashboardAlertIssue[] {
  const issues: DashboardAlertIssue[] = [];
  if (metrics.cpuPercent !== null && metrics.cpuPercent >= DASH_RED_THRESHOLD_PERCENT) issues.push('cpu');
  const ramPercent =
    metrics.ramUsedMb !== null && metrics.ramTotalMb ? (metrics.ramUsedMb / metrics.ramTotalMb) * 100 : null;
  if (ramPercent !== null && ramPercent >= DASH_RED_THRESHOLD_PERCENT) issues.push('ram');
  if (metrics.diskPercent !== null && metrics.diskPercent >= DASH_RED_THRESHOLD_PERCENT) issues.push('disk');
  if (rebootRequired) issues.push('rebootRequired');
  return issues;
}

/**
 * DASH-09: «Больше не показывать» снимается сам собой, как только находка
 * перестаёт проявляться (self-clearing snooze) — иначе разовое нажатие
 * навсегда глушило бы предупреждение и для будущих, никак не связанных
 * повторений той же проблемы (диск снова забился спустя месяц, потребовался
 * новый reboot после следующих обновлений), а отменить mute было бы негде —
 * в UI нет отдельного экрана для этого (решение разработчика от 23.07.2026).
 */
function applyDismissals(
  rawIssues: DashboardAlertIssue[],
  dismissed: DashboardAlertIssue[]
): { keepDismissed: DashboardAlertIssue[]; issuesToShow: DashboardAlertIssue[] } {
  return {
    keepDismissed: dismissed.filter((issue) => rawIssues.includes(issue)),
    issuesToShow: rawIssues.filter((issue) => !dismissed.includes(issue))
  };
}

function parseMetrics(output: string): DashboardMetrics {
  const metrics: DashboardMetrics = { ...EMPTY_METRICS, topProcesses: [] };
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const num = (s: string | undefined): number | null => {
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };
    switch (parts[0]) {
      case 'CPU':
        metrics.cpuPercent = clampPercent(num(parts[1]));
        break;
      case 'RAM':
        metrics.ramUsedMb = num(parts[1]);
        metrics.ramTotalMb = num(parts[2]);
        break;
      case 'DISK':
        metrics.diskPercent = clampPercent(num(parts[1]));
        break;
      case 'UP':
        metrics.uptimeSeconds = num(parts[1]);
        break;
      case 'LOAD':
        metrics.loadAvg1 = num(parts[1]);
        metrics.loadAvg5 = num(parts[2]);
        metrics.loadAvg15 = num(parts[3]);
        break;
      case 'NET':
        metrics.netUpKbps = num(parts[1]);
        metrics.netDownKbps = num(parts[2]);
        break;
      case 'PROC': {
        const pid = num(parts[1]);
        const cpuPercent = num(parts[4]);
        const memPercent = num(parts[5]);
        if (pid !== null && parts[2] && parts[3] && cpuPercent !== null && memPercent !== null) {
          metrics.topProcesses.push({ pid, user: parts[2], cmd: parts[3], cpuPercent, memPercent });
        }
        break;
      }
    }
  }
  return metrics;
}

function clampPercent(n: number | null): number | null {
  if (n === null) return null;
  return Math.max(0, Math.min(100, n));
}

function poll(sessionId: string): void {
  const state = dashboards.get(sessionId);
  if (!state || state.running) return;
  state.running = true;
  // DASH-09: пока баннер ещё не решён (успех/неудача первого опроса), к
  // команде добавляется reboot-check — тот же канал, тот же интервал (DASH-07).
  const checkReboot = !state.firstSuccessDone;

  let output = '';
  let stderrOut = '';
  let settled = false;
  const finish = (metrics: DashboardMetrics): void => {
    if (settled) return;
    settled = true;
    state.running = false;
    if (dashboards.has(sessionId)) send(sessionId, metrics);
  };
  // Диагностика «—» в лог соединения (однократно): без этого причину
  // недоступности метрик было невозможно увидеть нигде (DASH-05).
  const logProblem = (key: string, params?: Record<string, string | number>): void => {
    if (state.problemLogged) return;
    state.problemLogged = true;
    state.logger(key, params);
  };

  const timeout = setTimeout(() => {
    logProblem('clog.dashboardTimeout');
    finish({ ...EMPTY_METRICS });
  }, EXEC_TIMEOUT_MS);

  // TERM-08: пинг — время открытия exec-канала (CHANNEL_OPEN → CHANNEL_OPEN_CONFIRMATION),
  // побочный замер уже идущего опроса дашборда, без отдельных запросов к серверу.
  // Не время до stream 'close' — там сидит серверный `sleep 0.4` из METRICS_COMMAND.
  const execStartedAt = Date.now();
  state.client.exec(checkReboot ? METRICS_COMMAND + REBOOT_CHECK_COMMAND : METRICS_COMMAND, (err, stream) => {
    const pingMs = Date.now() - execStartedAt;
    if (err) {
      clearTimeout(timeout);
      logProblem('clog.dashboardExecError', { error: err.message });
      finish({ ...EMPTY_METRICS }); // канал недоступен → «—» (DASH-05)
      return;
    }
    stream.on('data', (d: Buffer) => {
      output += d.toString('utf8');
      if (output.length > 8192) stream.close();
    });
    stream.on('close', () => {
      clearTimeout(timeout);
      const metrics = parseMetrics(output);
      metrics.pingMs = pingMs;
      const empty =
        metrics.cpuPercent === null &&
        metrics.ramUsedMb === null &&
        metrics.diskPercent === null &&
        metrics.uptimeSeconds === null;
      if (empty) {
        // exec отработал, но ни одной метрики не распознано — покажем хвосты
        // stdout/stderr (усечённые), чтобы было ясно, что ответил сервер.
        logProblem('clog.dashboardNoData', {
          stdout: output.trim().slice(0, 200) || '—',
          stderr: stderrOut.trim().slice(0, 200) || '—'
        });
      } else if (checkReboot && !state.firstSuccessDone) {
        // DASH-09: первый успешный опрос — одноразовое решение о health-баннере.
        state.firstSuccessDone = true;
        const rawIssues = computeAlertIssues(metrics, parseRebootRequired(output));
        const dismissed = listDismissedAlerts(state.hostId);
        const { keepDismissed, issuesToShow } = applyDismissals(rawIssues, dismissed);
        if (keepDismissed.length !== dismissed.length) {
          // Часть замьюченных находок больше не проявляется — снимаем mute (self-clearing).
          replaceDismissedAlerts(state.hostId, keepDismissed);
        }
        if (issuesToShow.length > 0) sendAlert(sessionId, { issues: issuesToShow });
      }
      finish(metrics);
    });
    stream.stderr?.on('data', (d: Buffer) => {
      stderrOut += d.toString('utf8'); // только для диагностики, не парсится
    });
  });
}

export function startDashboard(
  sessionId: string,
  client: Pick<Connection, 'exec'>,
  hostId: number,
  logger: DashboardLogger
): void {
  stopDashboard(sessionId);
  const timer = setInterval(() => poll(sessionId), INTERVAL_MS);
  dashboards.set(sessionId, {
    timer,
    client,
    hostId,
    running: false,
    logger,
    problemLogged: false,
    firstSuccessDone: false
  });
  poll(sessionId); // первый замер сразу
}

export function stopDashboard(sessionId: string): void {
  const state = dashboards.get(sessionId);
  if (state) {
    clearInterval(state.timer);
    dashboards.delete(sessionId);
  }
}

/** Экспорт парсера для юнит-тестов (DASH-02). */
export const parseMetricsForTest = parseMetrics;

/** Экспорт для юнит-тестов (DASH-09). */
export const parseRebootRequiredForTest = parseRebootRequired;
export const computeAlertIssuesForTest = computeAlertIssues;
export const applyDismissalsForTest = applyDismissals;
export const METRICS_COMMAND_FOR_TEST = METRICS_COMMAND;
export const REBOOT_CHECK_COMMAND_FOR_TEST = REBOOT_CHECK_COMMAND;
