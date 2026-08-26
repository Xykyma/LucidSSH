import { IPC } from '@shared/ipc';
import type { ErrorExplanation } from '@shared/content';
import type { GuardStatus } from '@shared/history';
import { isSignalExitCode } from '@shared/ssh';
import { emit } from '../ipc/events';
import { loadConfig } from '../config/store';
import { getHost } from '../hosts/repository';
import { loadErrorPatterns, loadCommandCatalog } from '../content/loader';
import { detectError, excerpt, isEmptyOutput, isNonErrorExitCode } from '../errors/detector';
import { maskSecrets } from '../secrets/maskers';
import { extractCommandName, findCommandSuggestions } from '../errors/fuzzyMatch';
import { t } from '../i18n';
import { recordHistory } from '../history/repository';
import { notifyCommandDone } from '../notifications/notifier';
import type { ShellIntegrationEvent } from './shellIntegrationSession';

/**
 * Отвечает на вопрос «что пользователь и история узна́ют о том, что произошло
 * в Сессии»: объяснить ошибку (ERR), записать в историю (HIST), уведомить
 * (NOTIF). Перенесено из sessionManager.ts как есть — ни одна развилка не
 * менялась (.scratch/shell-channel-extraction/spec.md, issue 02).
 */

/** Личность Сессии, нужная этому модулю — одной записью, а не по аргументу на
 *  поле (см. «Личность сессии — одной записью» в спеке): иначе recordCommand
 *  звался бы четырьмя позиционными строками подряд. */
export interface SessionIdentity {
  id: string;
  hostId: number;
  hostName: string;
  /** HM-11: фоллбэк username для Quick Connect (hostId=0), где getHost(0)
   *  всегда null. */
  quickConnectUsername?: string;
}

/**
 * Некоторые серверы аутентифицируют успешно, но не могут открыть интерактивную
 * сессию (login shell = nologin и т.п.) — канал сразу закрывается, ssh2 не
 * эмитит 'error' (это не ошибка аутентификации). Наш маркер breadcrumb в таком
 * случае никогда не приходит, поэтому обычный путь детектора (по exit code
 * команды) не срабатывает. Текст, который сервер успел прислать перед
 * закрытием канала (событие `unmarked-output` от ShellIntegrationSession.close()),
 * сверяется с базой паттернов scope 'ssh-connection'; совпадение показывается
 * как отдельное объяснение. Возвращает true при совпадении — вызывающая
 * сторона (sessionManager.ts) помечает сессию, чтобы client.on('close', ...)
 * не пытался переподключиться: повтор бесполезен.
 */
export function checkShellUnavailable(session: SessionIdentity, output: string): boolean {
  const patterns = loadErrorPatterns(loadConfig().language);
  const result = detectError(patterns, 'ssh-connection', output, null, '');
  if (result.matched) {
    emit(IPC.evError, session.id, result.explanation);
    return true;
  }
  return false;
}

/**
 * Обработка события «команда завершилась» от ShellIntegrationSession. Пустая
 * `command` — прямой ввод в xterm (main не знает его текста, история его не
 * пишет, см. HIST-01). При exit code ≠ 0 и включённой панели детектора
 * (SET-05) — матч по базе.
 */
export function handleCommandFinished(
  session: SessionIdentity,
  event: Extract<ShellIntegrationEvent, { kind: 'command-finished' }>
): void {
  const { command, exitCode, output, guardStatus, typed, durationMs } = event;

  // Запись в историю выполненной команды из композера (HIST-01). Прямой ввод в
  // xterm не записывается — его текст main не знает. Маскирование секретов — в
  // recordHistory (HIST-07).
  if (command) {
    recordCommand(session, command, exitCode, guardStatus, output);
    // NOTIF-02: тост о долгой/упавшей команде, если окно не в фокусе
    notifyCommandDone(session.hostName, exitCode, durationMs);
  }

  if (exitCode === null || exitCode === 0) return;
  // Прервано сигналом (напр. Ctrl+C во время `tail -f`/`journalctl -f`) — это
  // намеренное действие пользователя, а не ошибка команды.
  if (isSignalExitCode(exitCode)) return;
  // Пустой Enter: команды не было, $? унаследован от предыдущей — не детектор.
  if (!typed && !command) return;
  if (!loadConfig().ui.hints.errorPanel) return; // отключено в «Интерфейсе»

  const patterns = loadErrorPatterns(loadConfig().language);
  const result = detectError(patterns, 'command', output, exitCode, command);

  let explanation: ErrorExplanation;
  if (result.matched) {
    explanation = result.explanation;
    // ERR-07: для command-not-found ищем похожие имена в каталоге команд
    // (расстояние Левенштейна ≤ 2). Формулировка «возможно» — это догадка, не факт.
    if (explanation.id === 'command-not-found') {
      const catalog = loadCommandCatalog(loadConfig().language);
      const suggestions = findCommandSuggestions(
        extractCommandName(command),
        catalog.commands.map((c) => c.name)
      );
      if (suggestions.length > 0) explanation.suggestions = suggestions;
    }
  } else {
    // Исключения из ERR-01: ненулевой exit code — штатный результат самой
    // команды/намеренное действие пользователя, не сбой (найдено при
    // тестировании 2026-07-24, issue 03-error-detector-fires-on-benign-nonzero-exit).
    if (isNonErrorExitCode(command, output, exitCode)) return;
    // Fallback-шаблон (ERR-06): пустой stderr → осмысленный текст
    const explainKey = isEmptyOutput(output) ? 'errDetector.emptyOutput' : 'errDetector.fallbackExplain';
    explanation = {
      title: t('errDetector.fallbackTitle'),
      explanation: t(explainKey, { code: exitCode }),
      checks: [],
      source: 'fallback',
      command: maskSecrets(command).masked,
      exitCode,
      stderr: maskSecrets(excerpt(output)).masked
    };
  }
  emit(IPC.evError, session.id, explanation);
}

/** Запись команды в историю с учётом отключения истории (HIST-07). */
export function recordCommand(
  session: SessionIdentity,
  command: string,
  exitCode: number | null | undefined,
  guardStatus?: GuardStatus,
  output?: string
): void {
  const cfg = loadConfig();
  if (!cfg.history.enabled) return;
  const host = getHost(session.hostId);
  // HIST-07: флаг хоста переживает удаление вместе со строкой (hosts.db, ADR-0015).
  // Quick Connect (host === null, HM-11) не участвует — история пишется, как раньше.
  if (host && !host.historyEnabled) return;
  recordHistory({
    command,
    hostId: session.hostId,
    hostName: session.hostName,
    username: host?.username ?? session.quickConnectUsername ?? '',
    exitCode: exitCode ?? undefined,
    guardStatus,
    output
  });
  // HistoryDrawer, если уже открыт, не перечитывает список сам по себе —
  // нужен явный сигнал (тот же баг чинили для сниппетов, snippetsRevision).
  emit(IPC.evHistoryRecorded);
}
