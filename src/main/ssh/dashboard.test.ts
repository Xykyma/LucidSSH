import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_METRICS, type DashboardAlertIssue } from '@shared/dashboard';
import { IPC } from '@shared/ipc';
import type { Connection } from './connection';
import {
  computeAlertIssuesForTest,
  METRICS_COMMAND_FOR_TEST,
  mutesToKeepForTest,
  parseMetricsForTest,
  parseRebootRequiredForTest,
  REBOOT_CHECK_COMMAND_FOR_TEST,
  startDashboard,
  stopDashboard
} from './dashboard';

// In-memory подмена хранилища мьютов и шины событий — poll должен идти через
// реальный путь опроса (startDashboard → exec → parse → processResults), а
// границы (hosts.db, webContents) заменяются фиктивными (тикет 02).
const h = vi.hoisted(() => {
  const mutes = new Map<number, DashboardAlertIssue[]>();
  const emitted: Array<{ channel: string; args: unknown[] }> = [];
  return { mutes, emitted };
});

vi.mock('../hosts/dashboardMutes', () => ({
  listDismissedAlerts: (hostId: number): DashboardAlertIssue[] => h.mutes.get(hostId) ?? [],
  replaceDismissedAlerts: (hostId: number, issues: DashboardAlertIssue[]): void => {
    h.mutes.set(hostId, issues);
  },
  addDismissedAlert: (hostId: number, issue: DashboardAlertIssue): void => {
    const list = h.mutes.get(hostId) ?? [];
    if (!list.includes(issue)) h.mutes.set(hostId, [...list, issue]);
  }
}));

vi.mock('../ipc/events', () => ({
  emit: (channel: string, ...args: unknown[]): void => {
    h.emitted.push({ channel, args });
  }
}));

describe('parseMetrics (DASH-02)', () => {
  it('парсит полный набор метрик', () => {
    const out =
      'CPU 42\nRAM 1536 4096\nDISK 66\nUP 1234567\nLOAD 0.42 0.51 0.48\nNET 1.2 8.4\n' +
      'PROC 1234 root nginx 12.5 3.1\nPROC 5678 www-data php-fpm 8.0 5.5\n';
    expect(parseMetricsForTest(out)).toEqual({
      cpuPercent: 42,
      ramUsedMb: 1536,
      ramTotalMb: 4096,
      diskPercent: 66,
      uptimeSeconds: 1234567,
      loadAvg1: 0.42,
      loadAvg5: 0.51,
      loadAvg15: 0.48,
      netUpKbps: 1.2,
      netDownKbps: 8.4,
      pingMs: null,
      topProcesses: [
        { pid: 1234, user: 'root', cmd: 'nginx', cpuPercent: 12.5, memPercent: 3.1 },
        { pid: 5678, user: 'www-data', cmd: 'php-fpm', cpuPercent: 8.0, memPercent: 5.5 }
      ]
    });
  });

  it('клампит проценты в 0..100', () => {
    const m = parseMetricsForTest('CPU 150\nDISK -5\n');
    expect(m.cpuPercent).toBe(100);
    expect(m.diskPercent).toBe(0);
  });

  it('отсутствующие строки → null/пустой массив (DASH-05)', () => {
    const m = parseMetricsForTest('CPU 10\n');
    expect(m.cpuPercent).toBe(10);
    expect(m.ramUsedMb).toBeNull();
    expect(m.diskPercent).toBeNull();
    expect(m.uptimeSeconds).toBeNull();
    expect(m.loadAvg1).toBeNull();
    expect(m.netUpKbps).toBeNull();
    expect(m.topProcesses).toEqual([]);
  });

  it('пустой вывод → все null, процессы — пустой массив', () => {
    const m = parseMetricsForTest('');
    expect(m).toEqual({
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
    });
  });

  it('мусорные значения → null, не NaN', () => {
    const m = parseMetricsForTest('CPU abc\nRAM x y\nLOAD a b c\nNET x y\n');
    expect(m.cpuPercent).toBeNull();
    expect(m.ramUsedMb).toBeNull();
    expect(m.loadAvg1).toBeNull();
    expect(m.netUpKbps).toBeNull();
  });

  it('строку PROC с нечисловым cpu/mem пропускает, не ломая остальные метрики', () => {
    const m = parseMetricsForTest('CPU 10\nPROC 1 root sshd bad bad\nPROC 2 root cron 1.0 0.5\n');
    expect(m.cpuPercent).toBe(10);
    expect(m.topProcesses).toEqual([
      { pid: 2, user: 'root', cmd: 'cron', cpuPercent: 1.0, memPercent: 0.5 }
    ]);
  });

  it('вызов parseMetrics дважды не делит общий массив topProcesses (нет утечки состояния)', () => {
    const m1 = parseMetricsForTest('PROC 1 root a 1 1\n');
    const m2 = parseMetricsForTest('');
    expect(m1.topProcesses).toHaveLength(1);
    expect(m2.topProcesses).toHaveLength(0);
  });
});

describe('parseRebootRequired (DASH-09)', () => {
  it('распознаёт строку REBOOT среди прочего вывода', () => {
    expect(parseRebootRequiredForTest('CPU 10\nREBOOT 1\nDISK 20\n')).toBe(true);
  });

  it('без строки REBOOT — false', () => {
    expect(parseRebootRequiredForTest('CPU 10\nDISK 20\n')).toBe(false);
  });

  it('пустой вывод — false', () => {
    expect(parseRebootRequiredForTest('')).toBe(false);
  });
});

describe('METRICS_COMMAND + REBOOT_CHECK_COMMAND (регрессия 23.07.2026)', () => {
  it('стык двух команд — разделитель, а не пробел: иначе `[ -f ... ]` уходит '
    + 'аргументом в предыдущий `awk` (в частности `-f <файл>` меняет источник '
    + 'программы awk), reboot-check никогда не выполняется', () => {
    const boundary = REBOOT_CHECK_COMMAND_FOR_TEST[0];
    expect(boundary === ';' || boundary === '\n').toBe(true);
    void METRICS_COMMAND_FOR_TEST; // сам METRICS_COMMAND не обязан оканчиваться на ';' — важен только стык
  });
});

describe('computeAlertIssues (DASH-09)', () => {
  it('здоровый сервер — баннер не показывается вообще', () => {
    const metrics = { ...EMPTY_METRICS, cpuPercent: 42, ramUsedMb: 1024, ramTotalMb: 4096, diskPercent: 66 };
    expect(computeAlertIssuesForTest(metrics, false)).toEqual([]);
  });

  it('CPU на красном пороге (≥90%) — находка cpu', () => {
    const metrics = { ...EMPTY_METRICS, cpuPercent: 95 };
    expect(computeAlertIssuesForTest(metrics, false)).toEqual(['cpu']);
  });

  it('RAM на красном пороге (доля занятой памяти ≥90%) — находка ram', () => {
    const metrics = { ...EMPTY_METRICS, ramUsedMb: 950, ramTotalMb: 1000 };
    expect(computeAlertIssuesForTest(metrics, false)).toEqual(['ram']);
  });

  it('диск заполнен на 93% — находка disk', () => {
    const metrics = { ...EMPTY_METRICS, diskPercent: 93 };
    expect(computeAlertIssuesForTest(metrics, false)).toEqual(['disk']);
  });

  it('reboot-required — находка rebootRequired', () => {
    expect(computeAlertIssuesForTest(EMPTY_METRICS, true)).toEqual(['rebootRequired']);
  });

  it('несколько условий одновременно — все находки в одном списке', () => {
    const metrics = { ...EMPTY_METRICS, cpuPercent: 95, diskPercent: 93 };
    expect(computeAlertIssuesForTest(metrics, true)).toEqual(['cpu', 'disk', 'rebootRequired']);
  });

  it('null-метрики (сервер недоступен) не считаются превышением порога', () => {
    expect(computeAlertIssuesForTest(EMPTY_METRICS, false)).toEqual([]);
  });
});

describe('mutesToKeep — self-clearing «Больше не показывать» (DASH-10, тикет 02)', () => {
  it('известное значение <90% снимает мьют соответствующей метрики', () => {
    const metrics = { ...EMPTY_METRICS, diskPercent: 50 };
    expect(mutesToKeepForTest(['disk'], metrics, null)).toEqual([]);
  });

  it('неизвестное значение (null) мьют сохраняет', () => {
    expect(mutesToKeepForTest(['cpu'], { ...EMPTY_METRICS }, null)).toEqual(['cpu']);
  });

  it('значение ≥90% мьют сохраняет', () => {
    const metrics = { ...EMPTY_METRICS, cpuPercent: 95 };
    expect(mutesToKeepForTest(['cpu'], metrics, null)).toEqual(['cpu']);
  });

  it('RAM решает вычисленная доля, а не округлённая строка (89.6% < 90%)', () => {
    const metrics = { ...EMPTY_METRICS, ramUsedMb: 896, ramTotalMb: 1000 };
    expect(mutesToKeepForTest(['ram'], metrics, null)).toEqual([]);
  });

  it('reboot-required: мьют сохраняется пока флаг есть, снимается при его отсутствии на проверке', () => {
    expect(mutesToKeepForTest(['rebootRequired'], { ...EMPTY_METRICS }, true)).toEqual(['rebootRequired']);
    expect(mutesToKeepForTest(['rebootRequired'], { ...EMPTY_METRICS }, false)).toEqual([]);
  });

  it('reboot не проверялся на этом опросе (null) — мьют сохраняется', () => {
    expect(mutesToKeepForTest(['rebootRequired'], { ...EMPTY_METRICS }, null)).toEqual(['rebootRequired']);
  });

  it('несколько мьютов решаются независимо', () => {
    const metrics = { ...EMPTY_METRICS, cpuPercent: 95, diskPercent: 50 };
    expect(mutesToKeepForTest(['cpu', 'disk', 'rebootRequired'], metrics, null)).toEqual([
      'cpu',
      'rebootRequired'
    ]);
  });
});

interface FakeStream {
  on: (event: string, handler: (data: Buffer) => void) => FakeStream;
  close: () => void;
  stderr: { on: (event: string, handler: (data: Buffer) => void) => void };
}

/**
 * Клиент, отвечающий на i-й exec i-м телом из очереди; тело Error — отказ
 * exec; после исчерпания очереди повторяется последнее тело. Ответ отдаётся
 * синхронно — тесты крутят полный цикл poll (startDashboard → exec → parse →
 * processResults) через fake-таймеры (интервал опроса 10 с).
 */
function makeClient(responses: Array<string | Error>): Pick<Connection, 'exec'> {
  let call = 0;
  return {
    exec: ((command: string, cb: (err: Error | null, stream: FakeStream) => void) => {
      void command;
      const handlers: Record<string, Array<(data: Buffer) => void>> = {};
      const stream: FakeStream = {
        on: (event, handler) => {
          (handlers[event] ??= []).push(handler);
          return stream;
        },
        close: () => undefined,
        stderr: { on: () => undefined }
      };
      const response = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      if (response instanceof Error) {
        cb(response, stream);
        return;
      }
      cb(null, stream);
      for (const handler of handlers['data'] ?? []) handler(Buffer.from(response));
      for (const handler of handlers['close'] ?? []) handler(Buffer.from(''));
    }) as Connection['exec']
  };
}

describe('poll — жизненный цикл находок на Соединение (тикет 02)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.mutes.clear();
    h.emitted.length = 0;
  });

  afterEach(() => {
    stopDashboard('s1');
    stopDashboard('s9');
    vi.useRealTimers();
  });

  /** alert-события в порядке отправки (args = [sessionId, alert]). */
  const alerts = (): DashboardAlertIssue[][] =>
    h.emitted
      .filter((e) => e.channel === IPC.evDashboardAlert)
      .map((e) => (e.args[1] as { issues: DashboardAlertIssue[] }).issues);

  const start = (sessionId: string, hostId: number, responses: Array<string | Error>): void => {
    startDashboard(sessionId, makeClient(responses), hostId, () => undefined);
  };

  /** Следующий опрос (интервал 10 с). */
  const poll = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(10_000);
  };

  it('CPU 95 → 12 → 96: показать, убрать при 12%, не вернуть при 96%', async () => {
    start('s1', 7, ['CPU 95\nUP 1', 'CPU 12\nUP 1', 'CPU 96\nUP 1', 'CPU 96\nUP 1']);
    expect(alerts()).toEqual([['cpu']]);
    await poll();
    expect(alerts()).toEqual([['cpu'], []]);
    await poll(); // 96% после восстановления — тишина
    await poll();
    expect(alerts()).toEqual([['cpu'], []]);
  });

  it('CPU 95 → null → 96: временно скрыть и вернуть', async () => {
    start('s1', 7, ['CPU 95\nUP 1', '', 'CPU 96\nUP 1']);
    expect(alerts()).toEqual([['cpu']]);
    await poll();
    expect(alerts()).toEqual([['cpu'], []]);
    await poll();
    expect(alerts()).toEqual([['cpu'], [], ['cpu']]);
  });

  it('CPU 95 → null → 12 → 96: после 12% окончательно убрать', async () => {
    start('s1', 7, ['CPU 95\nUP 1', '', 'CPU 12\nUP 1', 'CPU 96\nUP 1']);
    expect(alerts()).toEqual([['cpu']]);
    await poll();
    expect(alerts()).toEqual([['cpu'], []]);
    await poll(); // 12% — находка снята до конца Соединения, события нет
    expect(alerts()).toEqual([['cpu'], []]);
    await poll(); // повторный рост не возвращает
    expect(alerts()).toEqual([['cpu'], []]);
  });

  it('CPU 90% сохраняет находку, первое известное <90% снимает', async () => {
    start('s1', 7, ['CPU 90\nUP 1', 'CPU 90\nUP 1', 'CPU 89\nUP 1']);
    expect(alerts()).toEqual([['cpu']]);
    await poll(); // 90% — ещё активна, события нет
    expect(alerts()).toEqual([['cpu']]);
    await poll();
    expect(alerts()).toEqual([['cpu'], []]);
  });

  it('RAM 90.4% держит находку, 89.6% снимает (вычисленная доля, не округление)', async () => {
    start('s1', 7, ['RAM 904 1000\nUP 1', 'RAM 896 1000\nUP 1']);
    expect(alerts()).toEqual([['ram']]);
    await poll();
    expect(alerts()).toEqual([['ram'], []]);
  });

  it('первоначально 12 → 96: уведомления нет', async () => {
    start('s1', 7, ['CPU 12\nUP 1', 'CPU 96\nUP 1', 'CPU 96\nUP 1']);
    expect(alerts()).toEqual([]);
    await poll();
    await poll();
    expect(alerts()).toEqual([]);
  });

  it('метрика неизвестна на первом успешном опросе — находки для неё не будет', async () => {
    start('s1', 7, ['UP 1\nDISK 20', 'CPU 95\nUP 1', 'CPU 95\nUP 1']);
    expect(alerts()).toEqual([]);
    await poll();
    await poll();
    expect(alerts()).toEqual([]);
  });

  it('полностью неудачный опрос первоначальную проверку не расходует', async () => {
    start('s1', 7, ['', 'CPU 95\nUP 1']);
    expect(alerts()).toEqual([]); // пустой первый опрос
    await poll();
    expect(alerts()).toEqual([['cpu']]); // первый успешный — проверка случилась
  });

  it('exec-отказ после обнаружения временно скрывает без потери находки', async () => {
    start('s1', 7, ['CPU 95\nUP 1', new Error('exec failed'), 'CPU 96\nUP 1']);
    expect(alerts()).toEqual([['cpu']]);
    await poll();
    expect(alerts()).toEqual([['cpu'], []]);
    await poll();
    expect(alerts()).toEqual([['cpu'], [], ['cpu']]);
  });

  it('недоступность одной метрики не скрывает известные другие', async () => {
    start('s1', 7, ['CPU 95\nRAM 950 1000\nUP 1', 'CPU 95\nUP 1', 'CPU 95\nRAM 950 1000\nUP 1']);
    expect(alerts()).toEqual([['cpu', 'ram']]);
    await poll(); // RAM null — скрыта только она
    expect(alerts()).toEqual([['cpu', 'ram'], ['cpu']]);
    await poll();
    expect(alerts()).toEqual([['cpu', 'ram'], ['cpu'], ['cpu', 'ram']]);
  });

  it('reboot-required не скрывается нормализацией метрик и не восстанавливается ими', async () => {
    start('s1', 7, ['CPU 95\nUP 1\nREBOOT 1', 'CPU 10\nUP 1', 'CPU 95\nUP 1']);
    expect(alerts()).toEqual([['cpu', 'rebootRequired']]);
    await poll(); // cpu восстановился — reboot-required остался
    expect(alerts()).toEqual([['cpu', 'rebootRequired'], ['rebootRequired']]);
    await poll(); // повторный рост cpu в этом Соединении — тишина
    expect(alerts()).toEqual([['cpu', 'rebootRequired'], ['rebootRequired']]);
  });

  it('замьюченный диск 95 → null → 89%: мьют держится на null, снимается на 89%, уведомления нет', async () => {
    h.mutes.set(7, ['disk']);
    start('s1', 7, ['DISK 95\nUP 1', '', 'DISK 89\nUP 1', 'DISK 96\nUP 1']);
    expect(alerts()).toEqual([]);
    await poll(); // null — мьют сохраняется
    expect(h.mutes.get(7)).toEqual(['disk']);
    await poll(); // 89% <90 — самосброс
    expect(h.mutes.get(7)).toEqual([]);
    await poll(); // 96% — нового уведомления в текущем Соединении нет
    expect(alerts()).toEqual([]);
  });

  it('мьют на первоначально неизвестную метрику выживает при частичном ответе; чужой хост не затронут', async () => {
    h.mutes.set(7, ['cpu']);
    start('s1', 7, ['UP 1\nDISK 20', 'CPU 95\nUP 1']);
    start('s9', 9, ['CPU 95\nUP 1']);
    expect(alerts()).toEqual([['cpu']]); // уведомление только у хоста 9
    expect(h.mutes.get(7)).toEqual(['cpu']); // cpu был null при первом успешном — мьют выжил
    await poll();
    expect(alerts()).toEqual([['cpu']]); // хост 7 замьючен — новых событий нет
  });

  it('поздний close после timeout не расходует первоначальную проверку по протухшим данным', async () => {
    // Клиент отдаёт вывод, но не закрывает stream — close приходит после таймаута.
    const dataHandlers: Array<(data: Buffer) => void> = [];
    const closeHandlers: Array<(data: Buffer) => void> = [];
    const client = {
      exec: ((_command: string, cb: (err: Error | null, stream: FakeStream) => void) => {
        const stream: FakeStream = {
          on: (event, handler) => {
            if (event === 'data') dataHandlers.push(handler);
            if (event === 'close') closeHandlers.push(handler);
            return stream;
          },
          close: () => undefined,
          stderr: { on: () => undefined }
        };
        cb(null, stream);
      }) as Connection['exec']
    };
    startDashboard('s1', client, 7, () => undefined);
    for (const handler of dataHandlers) handler(Buffer.from('CPU 95\nUP 1'));
    await vi.advanceTimersByTimeAsync(8_000); // timeout: опрос обработан как неуспешный
    expect(alerts()).toEqual([]); // первоначальная проверка не расходована
    for (const handler of closeHandlers) handler(Buffer.from(''));
    expect(alerts()).toEqual([]); // поздний close ничего не решает повторно
  });

  it('новое Соединение (restart dashboard в той же сессии) начинает проверку заново', async () => {
    start('s1', 7, ['CPU 12\nUP 1']);
    expect(alerts()).toEqual([]);
    stopDashboard('s1'); // разрыв/переподключение — старое состояние умерло
    start('s1', 7, ['CPU 95\nUP 1']);
    expect(alerts()).toEqual([['cpu']]); // высокое значение снова даёт находку
  });
});
