import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import type { Settings } from '@shared/config';
import type { AuthPromptRequest } from '@shared/ssh';
import type { AccessRiskPrompt, DangerousCommandPrompt } from '@shared/guard';
import { getCurrentConfig } from '@/stores/config';
import { attachTerminalWriter, dropTerminalBuffer } from '@/stores/terminalBuffer';
import { Icon } from '@/components/common/Icon';
import { reconcileEchoLine, redrawEchoLine } from './localEcho';

/**
 * xterm.js-вью одной сессии (TERM-01, TERM-04, TERM-07).
 * Обезвреживание недоверенного вывода:
 * — вывод пишется через write(), не innerHTML;
 * — OSC 52 (запись в clipboard) отключён по умолчанию;
 * — scrollback ограничен;
 * — ссылки НЕ открываются автоматически (web-links addon не подключаем в 1.0).
 * Многострочная вставка перехватывается и уходит в предпросмотр (TERM-05, §14 гайда).
 * Экземпляры кэшируются по sessionId — буфер сохраняется при переключении вкладок.
 */

interface Cached {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  pasteAttached: boolean;
  /** Персистентный контейнер: term.open() вызывается один раз навсегда сюда,
   *  при переключении вкладок контейнер переносится (appendChild), не пересоздаётся. */
  container: HTMLDivElement;
}

const cache = new Map<string, Cached>();

/** Уведомление React-компонента о copy-on-select (создаётся в imperative-слое xterm). */
const copyListeners = new Map<string, () => void>();

/**
 * Локальный перехват ввода на время промпта пароля/passphrase (SSH-06):
 * пока промпт активен, нажатия НЕ уходят на сервер (шелла ещё нет) — копятся
 * здесь и по Enter отдаются в main через answerAuthPrompt. Маскированный ввод
 * не даёт эха — как настоящий "Password:" в консольном ssh.
 */
const authInterceptors = new Map<string, (data: string) => void>();
/** requestId промптов, чей текст уже напечатан (терминал кэшируется между
 *  переключениями вкладок — повторная печать давала бы дубль строки). */
const printedAuthPrompts = new Set<string>();

/**
 * Промпт пароля/passphrase активен (SSH-06) — вставленный текст (Ctrl+V или
 * правый клик) уходит в ТОТ ЖЕ маскированный перехватчик, что и печать
 * посимвольно, а не нативным вставлением в textarea: иначе секрет виден в
 * терминале открытым текстом (маскирование рассчитано на onData, не на
 * paste-событие) — найдено 22.07.2026 при живой проверке HM-12.
 * Возвращает true, если вставка поглощена перехватчиком (вызывающий останавливается).
 */
function maskPasteIfAuthPrompt(sessionId: string, text: string): boolean {
  const intercept = authInterceptors.get(sessionId);
  if (!intercept) return false;
  intercept(text);
  return true;
}

/**
 * Единый ввод: терминал сам решает, гнать ли строку через Стража, или
 * пропускать ввод сырым (см. план «Единый терминал-ввод», 13.07.2026).
 *
 * Пока сессия «на промпте» (atPromptState) — печатные символы копятся в
 * commandBuffers и локально эхуются в xterm (term.write), НЕ уходя на сервер
 * посимвольно; Enter прогоняет накопленную строку через submitCommand (тот же
 * IPC, что раньше дёргал композер). Когда сессия НЕ на промпте — считаем, что
 * шелл занят интерактивной программой (vim/htop): сырой ввод идёт напрямую,
 * без буферизации, иначе такие программы не будут реагировать на клавиши.
 *
 * «На промпте» узнаём из уже существующего сигнала breadcrumb (маркер
 * shell-интеграции прилетает на КАЖДОЕ приглашение, см. shellIntegration.ts) —
 * отдельный IPC-канал не нужен. Дефолт — true (fail-safe: пока сигналов не
 * было, считаем себя на промпте и проверяем).
 */
const commandBuffers = new Map<string, string>();
const atPromptState = new Map<string, boolean>();
const shellStateUnknown = new Map<string, boolean>();

/**
 * Эхо сверяется с экраном, а не считается по счётчику (ADR-0013,
 * .scratch/local-echo-resize-desync/spec.md) — детали в localEcho.ts.
 * echoStartCol — колонка, где Эхо начинается на своей экранной строке:
 * записывается при переходе Набранной строки из пустой в непустую,
 * переусваивается при расхождении со сверкой.
 */
const echoStartCol = new Map<string, number>();
/** Отложенная сверка: doFit взводит таймер, следующая запись из PTY (колбэк
 *  term.write) выполняет её раньше и снимает флаг сама; таймер — только
 *  страховка на случай, если PTY вообще ничего не пришлёт (rows-only resize,
 *  ADR-0005 не пускает его дальше renderer). handleCommandChar форсирует
 *  сверку немедленно, если застаёт флаг — иначе Enter в окне между resize и
 *  приходом данных отправил бы невидимую команду (ADR-0013 §4). */
const reconcilePending = new Map<string, ReturnType<typeof setTimeout>>();
/** Таймаут-страховка сверки (ADR-0013 §3) — цена безвредного таймера за то,
 *  что rows-only resize не дублирует гейт ADR-0005 в renderer. */
const RECONCILE_TIMEOUT_MS = 600;
const dangerListeners = new Map<string, (prompt: DangerousCommandPrompt) => void>();
const accessRiskListeners = new Map<string, (prompt: AccessRiskPrompt) => void>();
const commandSentListeners = new Map<string, () => void>();
const shellStateListeners = new Map<string, (unknown: boolean) => void>();

/** Локальная история команд (по стрелкам ↑/↓, как в обычном терминале) — не
 *  замена реальной shell-истории (нет tab-completion/reverse-search), просто
 *  последние отправленные строки текущей сессии. */
const commandHistories = new Map<string, string[]>();
const MAX_LOCAL_HISTORY = 200;
/** Индекс просматриваемой записи истории; undefined — не листаем сейчас. */
const historyIndex = new Map<string, number>();
/** Черновик текущей строки на момент начала пролистывания — восстанавливается
 *  при возврате стрелкой вниз ниже самой новой записи. */
const historyDraft = new Map<string, string>();

function isAtPrompt(sessionId: string): boolean {
  return atPromptState.get(sessionId) ?? true;
}

function setShellStateUnknown(sessionId: string, v: boolean): void {
  if (shellStateUnknown.get(sessionId) === v) return;
  shellStateUnknown.set(sessionId, v);
  shellStateListeners.get(sessionId)?.(v);
}

/** Вызывается на каждый breadcrumb-маркер сессии — «мы точно на промпте». */
function markAtPrompt(sessionId: string): void {
  atPromptState.set(sessionId, true);
  setShellStateUnknown(sessionId, false);
}

/** Вызывается на сигнал main-процесса «shell-интеграция не подтвердилась»
 *  (маркер не пришёл за echo-flush после отправки настройки, см.
 *  .scratch/prompt-confirmation-signal/spec.md) — fail-safe: возвращаем
 *  сессию под защиту Стража и предупреждаем пользователя. Источник точнее
 *  прежнего локального таймаута — main знает реальный момент отправки
 *  настройки, а не гадает по первой команде пользователя. */
function markIntegrationUnconfirmed(sessionId: string): void {
  atPromptState.set(sessionId, true);
  setShellStateUnknown(sessionId, true);
}

let breadcrumbSubscribed = false;
function ensureBreadcrumbSubscription(): void {
  if (breadcrumbSubscribed) return;
  breadcrumbSubscribed = true;
  window.lucidSSH.onBreadcrumb((sessionId) => markAtPrompt(sessionId));
  window.lucidSSH.onIntegrationUnconfirmed((sessionId) => markIntegrationUnconfirmed(sessionId));
}

/** Отменяет отложенную сверку (таймер-страховку) — вызывается после того,
 *  как сверка уже выполнилась (данными из PTY или самим таймером), и при
 *  очистке состояния сессии. */
function disarmReconcile(sessionId: string): void {
  const timer = reconcilePending.get(sessionId);
  if (timer !== undefined) clearTimeout(timer);
  reconcilePending.delete(sessionId);
}

/** Взводит сверку после doFit (ADR-0013 §3–4): триггер — любой doFit, гейт
 *  ADR-0005 по cols в renderer не дублируется. Настоящую сверку выполняет
 *  либо колбэк term.write на следующих данных из PTY, либо этот таймер,
 *  либо handleCommandChar, если пользователь набрал что-то раньше обоих. */
function armReconcile(sessionId: string): void {
  disarmReconcile(sessionId);
  reconcilePending.set(
    sessionId,
    setTimeout(() => runReconcile(sessionId), RECONCILE_TIMEOUT_MS)
  );
}

/** Сама сверка (ADR-0013 §3): дешёвая отсечка первой строкой — большинство
 *  вызовов (почти каждый чанк вывода) на ней и заканчивается. `done` (если
 *  дан) вызывается ПОСЛЕ того, как возможная перерисовка реально легла на
 *  сетку — `term.write` у xterm асинхронный (WriteBuffer), поэтому
 *  форсированный вызов из handleCommandChar (ADR-0013 §4) обязан дождаться
 *  этого колбэка, прежде чем читать состояние терминала для самого ввода
 *  (Backspace, история) — иначе он попадёт на ещё не применённую запись. */
function runReconcile(sessionId: string, done?: () => void): void {
  disarmReconcile(sessionId);
  const term = cache.get(sessionId)?.term;
  const text = isAtPrompt(sessionId) ? commandBuffers.get(sessionId) : undefined;
  const startCol = echoStartCol.get(sessionId);
  if (!term || !text || startCol === undefined) {
    done?.();
    return;
  }
  reconcileEchoLine(term, startCol, text, (newStartCol) => {
    echoStartCol.set(sessionId, newStartCol);
    done?.();
  });
}

/** Записывает колонку старта Эха при переходе Набранной строки из пустой в
 *  непустую — курсор в этот момент стоит там, где Эхо и начнётся, по
 *  определению (ADR-0013 §2). Не привязываемся к markAtPrompt/finalizeLine:
 *  привязка к промпту отвергнута, см. spec. */
function markEchoStart(sessionId: string): void {
  const term = cache.get(sessionId)?.term;
  if (term) echoStartCol.set(sessionId, term.buffer.active.cursorX);
}

function clearSessionInputState(sessionId: string): void {
  commandBuffers.delete(sessionId);
  atPromptState.delete(sessionId);
  shellStateUnknown.delete(sessionId);
  commandHistories.delete(sessionId);
  historyIndex.delete(sessionId);
  historyDraft.delete(sessionId);
  echoStartCol.delete(sessionId);
  disarmReconcile(sessionId);
}

/** Заменяет текущую набранную (но ещё не отправленную) строку на newText —
 *  перерисовывает область Эха примитивом из localEcho.ts вместо посимвольного
 *  backspace (тот не умел подниматься на строку выше при переносе — третий
 *  дефект класса из ADR-0013). */
function setBufferLine(sessionId: string, newText: string): void {
  const term = cache.get(sessionId)?.term;
  const old = commandBuffers.get(sessionId) ?? '';
  if (old.length > 0) {
    const startCol = echoStartCol.get(sessionId) ?? 0;
    if (term) redrawEchoLine(term, startCol, newText);
  } else if (newText.length > 0) {
    markEchoStart(sessionId);
    term?.write(newText);
  }
  commandBuffers.set(sessionId, newText);
}

function historyUp(sessionId: string): void {
  const hist = commandHistories.get(sessionId) ?? [];
  if (hist.length === 0) return;
  let idx = historyIndex.get(sessionId);
  if (idx === undefined) {
    historyDraft.set(sessionId, commandBuffers.get(sessionId) ?? '');
    idx = hist.length;
  }
  if (idx <= 0) return;
  idx -= 1;
  historyIndex.set(sessionId, idx);
  setBufferLine(sessionId, hist[idx]!);
}

function historyDown(sessionId: string): void {
  const hist = commandHistories.get(sessionId) ?? [];
  const idx = historyIndex.get(sessionId);
  if (idx === undefined) return;
  if (idx >= hist.length - 1) {
    historyIndex.delete(sessionId);
    setBufferLine(sessionId, historyDraft.get(sessionId) ?? '');
    historyDraft.delete(sessionId);
    return;
  }
  const next = idx + 1;
  historyIndex.set(sessionId, next);
  setBufferLine(sessionId, hist[next]!);
}

function finalizeLine(sessionId: string): void {
  const sent = commandBuffers.get(sessionId) ?? '';
  commandBuffers.set(sessionId, '');
  cache.get(sessionId)?.term.write('\r\n');
  atPromptState.set(sessionId, false);
  historyIndex.delete(sessionId);
  historyDraft.delete(sessionId);
  disarmReconcile(sessionId);
  if (sent.trim().length > 0) {
    const hist = commandHistories.get(sessionId) ?? [];
    if (hist[hist.length - 1] !== sent) hist.push(sent);
    while (hist.length > MAX_LOCAL_HISTORY) hist.shift();
    commandHistories.set(sessionId, hist);
  }
  commandSentListeners.get(sessionId)?.();
}

async function submitBufferedCommand(sessionId: string, command: string): Promise<void> {
  if (command.trim().length === 0) {
    commandBuffers.set(sessionId, '');
    cache.get(sessionId)?.term.write('\r\n');
    historyIndex.delete(sessionId);
    historyDraft.delete(sessionId);
    return;
  }
  const result = await window.lucidSSH.submitCommand(sessionId, command);
  if (result.status === 'blocked') {
    // Буфер и его эхо в терминале остаются как есть — DangerGuardModal
    // показывается поверх, пользователь может стереть/поправить сам (§ плана).
    dangerListeners.get(sessionId)?.(result.prompt);
  } else if (result.status === 'access-risk') {
    // GUARD-07: предупреждение о риске потери SSH-доступа — буфер так же
    // остаётся, AccessRiskModal поверх.
    accessRiskListeners.get(sessionId)?.(result.prompt);
  } else {
    finalizeLine(sessionId);
  }
}

/** Обрабатывает один чанк ввода, пока сессия на промпте (см. коммент выше). */
function handleCommandChar(sessionId: string, data: string): void {
  // Окно между doFit и приходом данных из PTY (ADR-0013 §4): если сверка
  // ещё не выполнилась, форсируем её немедленно по текущему состоянию
  // экрана — иначе Enter в этом окне отправил бы невидимую команду, а
  // сверка бы уже не помогла (finalizeLine отправляет раньше, чем данные
  // могли бы прийти и её выполнить). Обработку самого чанка откладываем до
  // колбэка: term.write асинхронный, если продолжить сразу же, Backspace
  // или история из ЭТОГО ЖЕ чанка прочитали бы состояние терминала ДО того,
  // как перерисовка сверки реально легла на сетку.
  if (reconcilePending.has(sessionId)) {
    runReconcile(sessionId, () => processCommandChunk(sessionId, data));
    return;
  }
  processCommandChunk(sessionId, data);
}

function processCommandChunk(sessionId: string, data: string): void {
  // Стрелки вверх/вниз — локальная история (см. commandHistories выше).
  if (data === '\x1b[A') {
    historyUp(sessionId);
    return;
  }
  if (data === '\x1b[B') {
    historyDown(sessionId);
    return;
  }
  // Прочие ESC-последовательности (Home/End и т.п.) буфер не поддерживает —
  // нет ни автодополнения, ни reverse-search. Целиком игнорируем.
  if (data.charCodeAt(0) === 0x1b) return;
  const term = cache.get(sessionId)?.term;
  for (const ch of data) {
    const code = ch.charCodeAt(0);
    if (ch === '\r' || ch === '\n') {
      const command = commandBuffers.get(sessionId) ?? '';
      void submitBufferedCommand(sessionId, command);
      return; // Enter завершает обработку чанка, остаток (если есть) отбрасываем
    }
    if (code === 0x03) {
      // Ctrl+C — на промпте прерывать нечего, но сбрасываем набранную строку
      // и шлём сигнал на сервер, как ожидает пользователь по привычке.
      commandBuffers.set(sessionId, '');
      term?.write('^C\r\n');
      // Один символ — заведомо короче порога проверки Стража, status всегда
      // 'sent'; await не нужен по сути, но сигнатура теперь Promise.
      void window.lucidSSH.sendTerminalInput(sessionId, ch);
      continue;
    }
    if (code === 0x7f || code === 0x08) {
      const buf = commandBuffers.get(sessionId) ?? '';
      if (buf.length > 0) {
        const newBuf = buf.slice(0, -1);
        commandBuffers.set(sessionId, newBuf);
        // Перерисовка вместо слепого '\b \b' (ADR-0013) — на экране может
        // быть уже не то, что мы думаем, стирать вслепую значит рисковать
        // съесть приглашение.
        const startCol = echoStartCol.get(sessionId) ?? 0;
        if (term) redrawEchoLine(term, startCol, newBuf);
      }
      continue;
    }
    if (code >= 0x20 || ch === '\t') {
      const buf = commandBuffers.get(sessionId) ?? '';
      if (buf.length === 0) markEchoStart(sessionId);
      commandBuffers.set(sessionId, buf + ch);
      term?.write(ch);
    }
    // Прочие управляющие символы игнорируются.
  }
}

export function destroyTerminal(sessionId: string): void {
  const c = cache.get(sessionId);
  if (c) {
    dropTerminalBuffer(sessionId);
    authInterceptors.delete(sessionId);
    clearSessionInputState(sessionId);
    c.term.dispose();
    c.container.remove();
    cache.delete(sessionId);
  }
}

export function getSearchAddon(sessionId: string): SearchAddon | undefined {
  return cache.get(sessionId)?.search;
}

/**
 * Применить настройки терминала ко всем живым сессиям без перезапуска (SET-02).
 * Меняем шрифт/размер/bold прямо в options и рефитим.
 */
export function applyTerminalConfig(cfg: Settings): void {
  const fontFamily = `'${cfg.terminal.font}', 'Cascadia Mono', Consolas, monospace`;
  for (const c of cache.values()) {
    c.term.options.fontFamily = fontFamily;
    c.term.options.fontSize = cfg.terminal.fontSize;
    c.term.options.drawBoldTextInBrightColors = cfg.terminal.brightBold;
    try {
      c.fit.fit();
    } catch {
      /* контейнер ещё без размера */
    }
  }
}

/** Короткий сигнал для bell='sound' (TERM-04). Терминал — жест пользователя, autoplay ок. */
function beep(): void {
  try {
    const AC = window.AudioContext;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
    osc.onended = () => void ctx.close();
  } catch {
    /* нет аудио — тихо игнорируем */
  }
}

export function getSelection(sessionId: string): string {
  return cache.get(sessionId)?.term.getSelection() ?? '';
}

export function copySelection(sessionId: string): void {
  const sel = getSelection(sessionId);
  if (sel) window.lucidSSH.clipboardWrite(sel);
}

/** Сырая отправка текста в сессию, без буфера/Стража — только когда сессия
 *  НЕ на промпте (внутри интерактивной программы), см. insertText ниже.
 *  Line endings нормализуются в LF: буфер обмена Windows кладёт CRLF, а bash
 *  сравнивает heredoc-терминатор («EOF») побайтово — «EOF\r» не совпадает с
 *  ожидаемым «EOF», и heredoc зависает в ожидании настоящего терминатора. */
export function pasteText(sessionId: string, text: string): void {
  void sendRawChecked(sessionId, text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  // Вызывается и из PastePreviewDialog — фокус после клика по кнопке
  // остаётся на ней, следующий Enter активирует кнопку повторно, а не
  // уходит в терминал (та же причина, что у insertText ниже).
  cache.get(sessionId)?.term.focus();
}

/**
 * Вставка текста из каталога/истории/сниппетов/breadcrumb-«cd» (GUARD-04) и
 * одиночной строки правым кликом. На промпте — дописывает в буфер строки с
 * локальным эхо (пройдёт Стража на следующем Enter, как обычный набор с
 * клавиатуры); вне промпта (внутри vim/htop) — идёт сырым текстом, как раньше.
 */
export function insertText(sessionId: string, text: string): void {
  if (isAtPrompt(sessionId)) {
    const buf = commandBuffers.get(sessionId) ?? '';
    if (buf.length === 0 && text.length > 0) markEchoStart(sessionId);
    commandBuffers.set(sessionId, buf + text);
    cache.get(sessionId)?.term.write(text);
  } else {
    pasteText(sessionId, text);
  }
  // Возвращаем фокус в терминал — иначе он остаётся на кликнутой кнопке
  // (каталог/история/сниппет), и следующий Enter активирует ЕЁ (нативное
  // поведение <button>), а не уходит в терминал: команда вставляется повторно.
  cache.get(sessionId)?.term.focus();
}

/** Общая точка сырой отправки: main проверяет достаточно длинные куски
 *  Стражем независимо от того, что решил renderer (см. submitRawInput,
 *  .scratch/raw-input-guard-check/spec.md) — заблокированный кусок так же
 *  открывает DangerGuardModal, как заблокированная команда на промпте. */
async function sendRawChecked(sessionId: string, text: string): Promise<void> {
  const result = await window.lucidSSH.sendTerminalInput(sessionId, text);
  if (result.status === 'blocked') {
    dangerListeners.get(sessionId)?.(result.prompt);
  } else if (result.status === 'access-risk') {
    accessRiskListeners.get(sessionId)?.(result.prompt);
  }
}

/** Текущий незавершённый ввод на промпте (для «Сохранить как сниппет»). */
export function getPendingLine(sessionId: string): string {
  return commandBuffers.get(sessionId) ?? '';
}

/** Опасная команда подтверждена (DangerGuardModal) — сервер уже её выполняет
 *  (confirmDangerousCommand сам шлёт), тут только приводим локальное состояние
 *  терминала в порядок: чистим буфер, печатаем перевод строки. */
export function confirmPendingLine(sessionId: string): void {
  finalizeLine(sessionId);
}

function createTerminal(sessionId: string): Cached {
  ensureBreadcrumbSubscription();
  const cfg = getCurrentConfig();
  const term = new Terminal({
    fontFamily: `'${cfg?.terminal.font ?? 'JetBrains Mono'}', 'Cascadia Mono', Consolas, monospace`,
    fontSize: cfg?.terminal.fontSize ?? 13,
    // 1.1: не значение line-height из макета (1.55, это межстрочник div-блоков
    // с текстом, а в xterm line-height растягивает всю ячейку — курсор-блок
    // заливает её целиком). Слегка ниже 1.2 — по просьбе уменьшить высоту
    // курсора-блока (единственный рычаг для этого в xterm, т.к. блочный
    // курсор всегда = высоте ячейки). Проверено визуально 07.07.2026.
    lineHeight: 1.1,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 5000,
    // ED2 (ESC[2J) уводит стёртый экран в scrollback, а не затирает вьюпорт
    // на месте (дефолт xterm.js). Без этого `top` съедал историю сессии
    // насовсем: в отличие от vim/less он НЕ переключается на alternate screen
    // (smcup/rmcup не шлёт вовсе — проверено на живом сервере 21.08.2026),
    // а чистит основной экран через ESC[H ESC[2J и не восстанавливает его —
    // после выхода по `q` прокручивать назад было уже нечего. Флаг включает
    // поведение PuTTY. Побочный эффект осознанный: `clear` и Ctrl+L тоже
    // перестают уничтожать стёртый экран — он остаётся в scrollback.
    scrollOnEraseInDisplay: true,
    drawBoldTextInBrightColors: cfg?.terminal.brightBold ?? true,
    theme: {
      background: '#1A1A22',
      foreground: '#CBD5E1',
      cursor: '#CBD5E1',
      selectionBackground: 'rgba(99,102,241,0.35)',
      black: '#15151B',
      brightBlack: '#475569',
      red: '#EF4444',
      green: '#4ADE80',
      yellow: '#FBBF24',
      blue: '#60A5FA',
      magenta: '#818CF8',
      cyan: '#22D3EE',
      white: '#CBD5E1',
      brightWhite: '#F1F5F9'
    }
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);

  term.onData((data) => {
    // Промпт пароля активен — ввод обрабатывается локально, не сервером
    const intercept = authInterceptors.get(sessionId);
    if (intercept) {
      intercept(data);
      return;
    }
    if (!isAtPrompt(sessionId)) {
      // Внутри интерактивной программы (vim/htop) — сырой посимвольный поток,
      // Enter там значит не «выполнить команду». Кусок может оказаться целой
      // вставленной командой (однострочный paste доходит сюда же, не только
      // через textarea paste-event) — проверяем через тот же sendRawChecked.
      void sendRawChecked(sessionId, data);
      return;
    }
    handleCommandChar(sessionId, data);
  });

  // TERM-04 bell: звуковой сигнал при \a, если включён в настройках
  term.onBell(() => {
    if (getCurrentConfig()?.terminal.bell === 'sound') beep();
  });

  // TERM-04 select-to-copy: выделение → буфер обмена (если включено)
  term.onSelectionChange(() => {
    if (getCurrentConfig()?.terminal.selectToCopy) {
      const sel = term.getSelection();
      if (sel) {
        window.lucidSSH.clipboardWrite(sel);
        copyListeners.get(sessionId)?.();
      }
    }
  });

  // Вывод сервера — из буфера (накопленное до монтирования + живой поток).
  // Колбэк term.write вызывается, когда чанк разобран и лёг на сетку — это
  // и есть единственная точка сверки Эха с экраном (ADR-0013 §3), таймер
  // не нужен.
  attachTerminalWriter(sessionId, (data) => {
    term.write(data, () => runReconcile(sessionId));
  });

  const container = document.createElement('div');
  container.className = 'h-full w-full';
  term.open(container);

  return { term, fit, search, pasteAttached: false, container };
}

export function XtermView({
  sessionId,
  onContextMenu,
  onMultilinePaste,
  authPrompt,
  onAuthAnswer,
  onDanger,
  onAccessRisk,
  onCommandSent,
  onShellStateChange
}: {
  sessionId: string;
  onContextMenu: (x: number, y: number) => void;
  onMultilinePaste: (text: string) => void;
  /** Активный промпт пароля/passphrase (SSH-06) — ввод в терминале, как в ssh. */
  authPrompt?: AuthPromptRequest;
  onAuthAnswer?: (answers: string[]) => void;
  /** Опасная команда, набранная прямо в терминале (GUARD-02) — открыть DangerGuardModal. */
  onDanger?: (prompt: DangerousCommandPrompt) => void;
  /** Риск потери SSH-доступа (GUARD-07) — открыть AccessRiskModal. */
  onAccessRisk?: (prompt: AccessRiskPrompt) => void;
  /** Команда отправлена на сервер (для SNIP-08). */
  onCommandSent?: () => void;
  /** Не удалось определить, на промпте ли сессия (busybox без shell-интеграции и т.п.). */
  onShellStateChange?: (unknown: boolean) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const cbRef = useRef({ onContextMenu, onMultilinePaste });
  cbRef.current = { onContextMenu, onMultilinePaste };
  const onAuthAnswerRef = useRef(onAuthAnswer);
  onAuthAnswerRef.current = onAuthAnswer;
  const [showCopied, setShowCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    copyListeners.set(sessionId, () => {
      setShowCopied(true);
      // Выделение большого текста с прокруткой шлёт много onSelectionChange —
      // таймер перезапускаем на каждый, иначе тост гаснет ещё до конца выделения.
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setShowCopied(false), 1100);
    });
    if (onDanger) dangerListeners.set(sessionId, onDanger);
    if (onAccessRisk) accessRiskListeners.set(sessionId, onAccessRisk);
    if (onCommandSent) commandSentListeners.set(sessionId, onCommandSent);
    if (onShellStateChange) shellStateListeners.set(sessionId, onShellStateChange);
    return () => {
      copyListeners.delete(sessionId);
      dangerListeners.delete(sessionId);
      accessRiskListeners.delete(sessionId);
      commandSentListeners.delete(sessionId);
      shellStateListeners.delete(sessionId);
      clearTimeout(copiedTimerRef.current);
    };
  }, [sessionId, onDanger, onAccessRisk, onCommandSent, onShellStateChange]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    let cached = cache.get(sessionId);
    if (!cached) {
      cached = createTerminal(sessionId);
      cache.set(sessionId, cached);
    }
    if (cached.container.parentElement !== el) {
      el.appendChild(cached.container);
    }

    // Перехват вставки: textarea появляется только после open() — вешаем один раз.
    // При активном промпте пароля секрет маскируется (maskPasteIfAuthPrompt).
    // Многострочный текст (вне промпта пароля) уходит в предпросмотр (TERM-05);
    // одиночная строка (вне промпта пароля) — штатно через xterm.onData.
    const textarea = cached.term.textarea;
    if (textarea && !cached.pasteAttached) {
      cached.pasteAttached = true;
      textarea.addEventListener(
        'paste',
        (e: ClipboardEvent) => {
          const text = e.clipboardData?.getData('text') ?? '';
          if (maskPasteIfAuthPrompt(sessionId, text)) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (text.includes('\n') || text.includes('\r')) {
            e.preventDefault();
            e.stopPropagation();
            cbRef.current.onMultilinePaste(text);
          }
        },
        true
      );
    }

    const doFit = (): void => {
      try {
        cached!.fit.fit();
        window.lucidSSH.resizeSession(sessionId, cached!.term.cols, cached!.term.rows);
        // Триггер сверки — любой doFit, без уточнений (ADR-0013 §3): гейт по
        // cols из ADR-0005 не дублируется здесь, сверке всё равно, что было
        // причиной расхождения.
        armReconcile(sessionId);
      } catch {
        /* контейнер ещё без размера */
      }
    };
    doFit();
    cached.term.focus();

    const onCtx = (e: MouseEvent): void => {
      e.preventDefault();
      // TERM-04 правый клик = вставка: читаем буфер, многострочное — в предпросмотр
      if (getCurrentConfig()?.terminal.rightClickPaste) {
        void window.lucidSSH.clipboardRead().then((text) => {
          if (!text) return;
          if (maskPasteIfAuthPrompt(sessionId, text)) return;
          if (text.includes('\n') || text.includes('\r')) cbRef.current.onMultilinePaste(text);
          else insertText(sessionId, text);
        });
        return;
      }
      cbRef.current.onContextMenu(e.clientX, e.clientY);
    };
    el.addEventListener('contextmenu', onCtx);

    const ro = new ResizeObserver(doFit);
    ro.observe(el);
    return () => {
      ro.disconnect();
      el.removeEventListener('contextmenu', onCtx);
    };
  }, [sessionId]);

  // Промпт пароля: печатаем текст в сам терминал и перехватываем ввод до
  // Enter — как консольный ssh. Маскированный ввод (echo=false) эха не даёт.
  // Эффект ПОСЛЕ эффекта монтирования: тот создаёт терминал в cache.
  useEffect(() => {
    if (!authPrompt) return;
    const term = cache.get(sessionId)?.term;
    if (!term) return;
    const { requestId, prompts } = authPrompt;
    if (!printedAuthPrompts.has(requestId)) {
      printedAuthPrompts.add(requestId);
      term.write(`\r\n${prompts[0]?.text ?? ''} `);
    }
    let idx = 0;
    let current = '';
    const answers: string[] = [];
    authInterceptors.set(sessionId, (data) => {
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          answers.push(current);
          current = '';
          term.write('\r\n');
          idx++;
          if (idx >= prompts.length) {
            authInterceptors.delete(sessionId);
            printedAuthPrompts.delete(requestId);
            onAuthAnswerRef.current?.(answers);
            return; // хвост чанка после Enter отбрасываем
          }
          term.write(`${prompts[idx]?.text ?? ''} `);
        } else if (ch === '\x7f' || ch === '\b') {
          if (current.length > 0) {
            current = current.slice(0, -1);
            if (prompts[idx]?.echo) term.write('\b \b');
          }
        } else if (ch >= ' ') {
          current += ch;
          if (prompts[idx]?.echo) term.write(ch);
        }
        // Остальные управляющие символы (Ctrl+C, стрелки) игнорируются
      }
    });
    term.focus();
    return () => {
      authInterceptors.delete(sessionId);
    };
  }, [sessionId, authPrompt]);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" />
      {showCopied && (
        <div
          className="animate-[esh-pop_.16s_ease] pointer-events-none absolute right-3 bottom-3 z-20 flex items-center gap-1 rounded-[20px] border border-border-strong bg-bg-elevated px-3 py-[6px] text-[11.5px] text-text-strong shadow-[0_8px_20px_rgba(0,0,0,0.35)]"
          aria-hidden="true"
        >
          <Icon name="check" size={12} className="text-success-bright" />
          {t('terminal.copied')}
        </div>
      )}
    </div>
  );
}
