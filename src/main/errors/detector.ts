import type { ErrorExplanation, ErrorPattern, ErrorScope, FallbackRef } from '@shared/content';
import { maskSecrets } from '../secrets/maskers';
import { stripCmdPrefix } from '../guard/patterns';

/**
 * Детектор ошибок (ERR-01…06). Матчинг по exit code + тексту stderr/вывода
 * против встроенной базы (офлайн, без LLM в 1.0). Подстановки {original}/{target}
 * в подсказках-командах — БЕЗОПАСНЫ: это текст для показа/вставки, не исполнение.
 *
 * Возвращает найденное объяснение из базы либо fallback-хук (в 1.0 → doc-search;
 * с локальными ИИ-объяснениями тот же контракт направляется в LLM, §12.13 ТЗ). Контракт не
 * меняется — точка расширения заложена.
 */

export type DetectResult =
  | { matched: true; explanation: ErrorExplanation }
  | { matched: false; fallback: FallbackRef };

/** Извлечь «цель» из команды: последний аргумент, похожий на путь/имя. */
function extractTarget(command: string): string {
  const tokens = command.trim().split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i]!;
    if (!tok.startsWith('-') && tok !== '') return tok;
  }
  return '';
}

function substitute(command: string, original: string, target: string): string {
  return command.replaceAll('{original}', original).replaceAll('{target}', target);
}

/** Обрезка фрагмента stderr для fallback/логов после маскирования секретов. */
export function excerpt(text: string, max = 500): string {
  // Сначала срез, потом trim без регэкспа: /\s+$/ по всему выводу (до 64 КБ)
  // квадратичен на длинной серии пробелов.
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1]!)) end--;
  return text.slice(Math.max(0, end - max), end);
}

/**
 * Компиляция паттерна с поддержкой ведущих инлайн-флагов вида `(?i)` / `(?im)`.
 * JS RegExp такие флаги в теле не понимает — переносим их в аргумент flags.
 */
export function compilePattern(match: string): RegExp | null {
  let source = match;
  let flags = '';
  const inline = /^\(\?([a-z]+)\)/.exec(source);
  if (inline && inline[1]) {
    for (const f of inline[1]) {
      if ('imsuy'.includes(f) && !flags.includes(f)) flags += f;
    }
    source = source.slice(inline[0].length);
  }
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

export function detectError(
  patterns: ErrorPattern[],
  scope: ErrorScope,
  output: string,
  exitCode: number | null,
  command: string
): DetectResult {
  // Маскируем ДО извлечения {target} и подстановки {original} — иначе секрет из
  // команды (`export API_KEY=secret`) утёк бы в подсказки checks[].command,
  // которые показываются в панели и копируются отдельной кнопкой (ERR-08).
  const maskedCommand = maskSecrets(command).masked;
  const target = extractTarget(maskedCommand);

  for (const p of patterns) {
    if (p.scope !== scope) continue;
    const re = compilePattern(p.match);
    if (!re) continue; // повреждённый паттерн не должен ронять детектор
    if (re.test(output)) {
      return {
        matched: true,
        explanation: {
          title: p.title,
          explanation: p.explanation,
          checks: p.checks.map((c) => ({
            text: c.text,
            command: c.command ? substitute(c.command, maskedCommand, target) : undefined
          })),
          source: 'database',
          command: maskedCommand,
          id: p.id,
          exitCode: exitCode ?? undefined,
          stderr: maskSecrets(excerpt(output)).masked
        }
      };
    }
  }

  // Не распознано — fallback-хук (ERR-06). В 1.0 kind='doc-search'.
  return {
    matched: false,
    fallback: {
      kind: 'doc-search',
      command,
      exitCode: exitCode ?? undefined,
      stderrExcerpt: excerpt(output)
    }
  };
}

/**
 * Пустой stderr при exit code ≠ 0 (ERR-06): осмысленный текст вместо пустой панели.
 */
export function isEmptyOutput(output: string): boolean {
  return output.trim().length === 0;
}

// --- Исключения из ERR-01 (найдены при ручном тестировании 2026-07-24) -----
// Три узких, независимых случая, где ненулевой exit code — штатный результат
// самой команды/действия пользователя, а не сбой. Проверяются ТОЛЬКО в ветке
// «ничего не распознано по базе» (fallback ERR-06) — обычные паттерны
// errors.core.json всегда матчатся первыми и не затрагиваются этой проверкой.

/** Явный редирект stderr в /dev/null — типичные варианты записи. */
const STDERR_TO_DEVNULL_RE = /2>\s*\/dev\/null|>\s*\/dev\/null\s+2>&1|2>&1\s+>\s*\/dev\/null/;

/**
 * Составная команда (`&&`/`||`) с намеренно подавленным stderr одного из
 * сегментов: пользователь сам решил не видеть ошибку этой части — уважаем.
 */
function isSuppressedByStderrRedirect(command: string, output: string): boolean {
  if (!isEmptyOutput(output)) return false;
  if (!/&&|\|\|/.test(command)) return false;
  return STDERR_TO_DEVNULL_RE.test(command);
}

interface StatusCommandRule {
  re: RegExp;
  /** Коды, для которых ненулевой возврат — штатный ответ, не ошибка. */
  suppressedExitCodes: number[];
}

/**
 * Команды вида «показать статус», где ненулевой код — содержательный ответ
 * (LSB-конвенция systemd: 1/2/3 = «не запущен» в разных видах). Код 4
 * («статус неизвестен» — юнит не найден, например из-за опечатки) сюда не
 * входит намеренно: это настоящая проблема, детектор должен сработать.
 */
const STATUS_COMMAND_RULES: StatusCommandRule[] = [
  { re: /^systemctl\s+(?:--\S+\s+)*status\b/, suppressedExitCodes: [1, 2, 3] },
  { re: /^service\s+\S+\s+status\b/, suppressedExitCodes: [1, 2, 3] }
];

function isKnownStatusExitCode(command: string, exitCode: number): boolean {
  const unprefixed = stripCmdPrefix(command.trim());
  return STATUS_COMMAND_RULES.some(
    (rule) => rule.re.test(unprefixed) && rule.suppressedExitCodes.includes(exitCode)
  );
}

// Ровно формы промпта из решения грилинга — не расширять произвольно (иначе
// растёт риск принять чужой текст за отказ от подтверждения).
const CONFIRM_PROMPT_RE = /\[y\/n\]|\(y\/n\)|\(yes\/no\)/i;
const NEGATIVE_ANSWER_RE = /^(?:n|no)$/i;

/** Короткая строка после ответа (типа «Abort.») — ещё похоже на завершение
 *  отказа, а не на настоящую ошибку (у той были бы детали/цифры/длиннее). */
const MAX_TRAILING_LINE_LENGTH = 40;

/**
 * Отказ от интерактивного [Y/n]-подтверждения: программа сама остановила
 * действие по воле пользователя, это не ошибка команды. Признак — промпт
 * (с ответом на той же или следующей строке) ближе к концу вывода, с не
 * более чем одной короткой строкой после (типичное «Abort.»/«Отменено.» —
 * реальная ошибка после отказа выглядела бы длиннее и содержала бы детали).
 */
function isDeclinedConfirmation(output: string): boolean {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!CONFIRM_PROMPT_RE.test(line)) continue;

    const afterPrompt = line.replace(new RegExp(`^.*(?:${CONFIRM_PROMPT_RE.source})`, 'i'), '').trim();
    const declinedSameLine = NEGATIVE_ANSWER_RE.test(afterPrompt);
    const nextLine = lines[i + 1];
    const declinedNextLine = nextLine !== undefined && NEGATIVE_ANSWER_RE.test(nextLine);
    if (!declinedSameLine && !declinedNextLine) return false;

    const answerLineIndex = declinedSameLine ? i : i + 1;
    const tail = lines.slice(answerLineIndex + 1);
    if (tail.length > 1) return false;
    if (tail.length === 1 && (tail[0]!.length > MAX_TRAILING_LINE_LENGTH || /\d/.test(tail[0]!))) return false;
    return true;
  }
  return false;
}

/**
 * Три исключения из ERR-01 (решение зафиксировано в
 * `.scratch/client-bugs-2026-07-24/issues/03-error-detector-fires-on-benign-nonzero-exit.md`):
 * ненулевой exit code, который не должен открывать панель детектора, потому
 * что это штатный/намеренный результат, а не сбой. Проверять только когда
 * `detectError` вернул `matched: false` — обычные паттерны базы приоритетнее.
 */
export function isNonErrorExitCode(command: string, output: string, exitCode: number | null): boolean {
  if (exitCode === null) return false;
  return (
    isSuppressedByStderrRedirect(command, output) ||
    isKnownStatusExitCode(command, exitCode) ||
    isDeclinedConfirmation(output)
  );
}
