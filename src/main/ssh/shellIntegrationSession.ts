import { randomBytes } from 'node:crypto';
import type { Breadcrumb } from '@shared/breadcrumb';
import type { GuardStatus } from '@shared/history';
import type { InteractiveProgramName } from '@shared/interactivePrograms';
import {
  BreadcrumbParser,
  CommandGate,
  EchoGate,
  detectInteractiveProgram,
  endsWithInputPrompt,
  endsWithOwnShellPrompt,
  endsWithShellPrompt,
  isShellEscalationCommand,
  matchesPasswordPromptPattern,
  shellIntegrationSetup,
  stripTerminalControls
} from './shellIntegration';

/**
 * Оркестровка конвейера разбора вывода shell-интеграции (BRD-03/04, TERM-09,
 * ERR-01) — deep module вокруг `BreadcrumbParser`/`EchoGate`/`CommandGate`
 * (см. `.scratch/shell-integration-session/spec.md`). Сама коробка «не имеет
 * рук»: не пишет в provод и не заводит настоящих таймеров — только сообщает
 * вызывающему (`sessionManager.ts`), что сделать. Новый экземпляр создаётся на
 * каждое открытие shell-канала (в т.ч. после переподключения/эскалации),
 * старый выбрасывается — чистое состояние гарантирует конструктор, метода
 * reset() нет.
 */

// Отправка настройки: ждём паузу в выводе после MOTD (иначе окно подавления
// эха съест приветствие), но не дольше капа (см. sessionManager.ts, откуда
// эти константы переехали без изменения значений).
const SETUP_SILENCE_MS = 300;
// Экспортируется: sessionManager.ts заводит этот таймер сразу при открытии
// shell-канала (до первого feed()) — единственный таймер, который коробка не
// может попросить сама, т.к. её интерфейс не включает метод «канал открылся».
export const SETUP_CAP_MS = 2000;
const ECHO_FLUSH_TIMEOUT_MS = 3000;
const REINJECT_SILENCE_MS = 800;
const PENDING_ECHO_TIMEOUT_MS = 1500;
// Тикет 18: после маркера непоследней строки вставки readline тут же печатает
// следующую строку из очереди — сервер пишет это одним махом. Отсчёт идёт от
// последнего вывода без эха; запас — на медленный PS1 (git-prompt) между
// маркером и приглашением.
const PASTE_ECHO_WAIT_MS = 500;
// Сколько символов с края строки вставки ищем в эхе, и строки короче какой
// длины не ищем вовсе (`ls`, `cd` нашлись бы и в самом приглашении).
const PASTE_FRAGMENT = 16;
const MIN_PASTE_FRAGMENT = 3;
// Тикет 25: без маркеров «на промпте» угадывается по тишине после отправленной
// строки и форме приглашения в хвосте вывода.
const PROMPT_GUESS_MS = 1500;

/** Именованные таймеры, которыми управляет коробка. Реальные `setTimeout`
 *  остаются у вызывающего — коробка только просит завести/отменить их и
 *  ожидает вызова `tick(timer)`, когда время вышло. */
export type ShellIntegrationTimer = 'setup-silence' | 'setup-cap' | 'echo-flush' | 'reinject' | 'paste-echo' | 'prompt-guess';

export type TimerAction =
  | { timer: ShellIntegrationTimer; action: 'schedule'; ms: number }
  | { timer: ShellIntegrationTimer; action: 'cancel' };

export type ShellIntegrationEvent =
  /** atPrompt=false — маркер непоследней строки многострочной сырой вставки
   *  (тикет 18): шелл сейчас же выполнит следующую, renderer остаётся в сыром вводе.
   *  synthetic=true — «на промпте» объявлен по таймеру эха вставки, а не настоящим
   *  маркером шелла: из режима пароля (TERM-09) он renderer не выводит. */
  | { kind: 'breadcrumb'; crumb: Breadcrumb; atPrompt: boolean; synthetic: boolean }
  | {
      kind: 'command-finished';
      command: string;
      exitCode: number | null;
      output: string;
      guardStatus?: GuardStatus;
      typed: boolean;
      /** Для NOTIF-02 (тост о долгой/упавшей команде) — сколько прошло с writeCommand(). */
      durationMs: number;
    }
  | { kind: 'password-prompt' }
  /** BRD-05: команда запускает известную интерактивную программу (nano/vim/…) —
   *  renderer показывает статус-строку над breadcrumb до следующего маркера
   *  (см. 'breadcrumb' — конец интерактивной программы отдельным событием не
   *  сигналится, скрытие переиспользует уже существующий маркер прихода на промпт). */
  | { kind: 'interactive-program'; program: InteractiveProgramName }
  /** `close()` без единого маркера (nologin/ash-сценарии) — накопленный вывод
   *  для сверки с базой паттернов scope 'ssh-connection'. */
  | { kind: 'unmarked-output'; output: string }
  /** echo-flush сработал, а маркер после последней отправки настройки
   *  (первичной или реинжекта) так и не пришёл — shell-интеграция не
   *  подтвердилась (см. .scratch/prompt-confirmation-signal/spec.md). */
  | { kind: 'integration-unconfirmed' }
  /** Интеграция не подтвердилась, а после отправленной строки вывод затих на
   *  приглашении шелла (тикет 25): renderer снова на промпте под Стражем, режим
   *  пароля окончен. С рабочей интеграцией не испускается — там решает маркер. */
  | { kind: 'prompt-guess' };

/** Ответ коробки на любой из её методов: что показать в терминале, что
 *  записать в provод, какие таймеры (пере)завести/отменить, что произошло —
 *  в этом порядке вызывающий и должен применить результат. */
export interface ShellIntegrationResult {
  display: string;
  toWrite: string;
  events: ShellIntegrationEvent[];
  timerActions: TimerAction[];
}

interface PasteInFlight {
  /** Строки вставки; последняя — текст после последнего перевода строки
   *  (обычно пустая), маркера она не даёт. */
  lines: string[];
  marksSeen: number;
  /** Вывод после последнего маркера — где ищем эхо строки вставки. */
  echoTail: string;
  echoSeen: boolean;
}

function emptyResult(): ShellIntegrationResult {
  return { display: '', toWrite: '', events: [], timerActions: [] };
}

export class ShellIntegrationSession {
  private readonly breadcrumbParser: BreadcrumbParser;
  private readonly echoGate = new EchoGate();
  private readonly commandGate = new CommandGate();

  /** Вывод с момента предыдущего маркера — для детектора ошибок (ERR-01). */
  private outputSinceMark = '';
  /** Последняя команда, отправленная через writeCommand (для истории/{original}). */
  private lastCommand = '';
  private lastCommandStartedAt = 0;
  private pendingGuardStatus: GuardStatus | undefined;
  /** Без маркеров (тикет 26): шелл, судя по выводу, стоит на СВОЁМ приглашении
   *  (не REPL) и строки с тех пор не уходили. Только строка, отправленная в
   *  этом состоянии, — команда шелла для истории и WIN-04; иначе это ввод в
   *  программу (REPL, ответ на нераспознанный запрос после ложной догадки). */
  private atOwnShellPrompt = false;
  /** Первый маркер после подключения — приветствие, не результат команды. */
  private firstMarkSeen = false;
  /** Был ли ввод с прошлого маркера: первый ввод означает «приглашение
   *  дописано» — всё накопленное до него (OSC-заголовок + prompt) отбрасывается. */
  private inputSinceMark = false;
  /** Взводится при каждой отправке настройки (первичной и реинжекте),
   *  снимается любым пришедшим маркером — «ждём ли мы ещё маркер после
   *  ПОСЛЕДНЕЙ отправки настройки». Отдельно от firstMarkSeen: реинжект
   *  после sudo/su должен снова требовать подтверждения, даже если исходное
   *  подключение маркер уже видело. */
  private awaitingFirstMarkAfterSetup = false;
  /** Отправлена ли настройка shell integration в текущий shell. */
  private setupSent = false;
  /** Ожидаемое эхо только что отправленной через writeCommand команды —
   *  вырезается из вывода сервера, терминал уже показал её локально при наборе. */
  private pendingEcho: { text: string; armedAt: number } | undefined;
  /** Взведён реинжект интеграции после команды эскалации (фикс BRD-03/04). */
  private reinjectArmed = false;
  /** Хвост вывода с момента взвода реинжекта — распознавание запроса пароля. */
  private reinjectTail = '';
  /** Хвост вывода для детекции запроса пароля (TERM-09) и формы приглашения
   *  без маркеров (тикет 25), независим от реинжекта. */
  private outputTail = '';
  /** true между «увидели запрос пароля» и следующим маркером. */
  private passwordPromptActive = false;
  /** Последний echo-flush ушёл без маркера, и маркера с тех пор не было. */
  private integrationUnconfirmed = false;
  /** Без маркеров: после отправленной строки ждём тишину на приглашении. */
  private promptGuessArmed = false;
  /** Шелл на приглашении: последний breadcrumb ушёл с atPrompt и с тех пор не
   *  отправлено ни одного перевода строки — то же, что atPromptState в renderer. */
  private atPrompt = false;
  private lastCrumb: Breadcrumb | undefined;
  /**
   * Многострочная сырая вставка с приглашения (тикет 18). Переводов строк в
   * ней — верхняя граница числа маркеров: heredoc, `\`, циклы,
   * строки, съеденные read/vim/ssh, маркера не дают, а Ctrl+C сбрасывает
   * очередь tty. Поэтому маркер непоследней строки держит сырой ввод, только
   * если следом пришло эхо ещё одной строки вставки (readline печатает строку
   * из очереди); иначе через PASTE_ECHO_WAIT_MS приглашение считается
   * настоящим. Промах признака даёт прежнее поведение («на промпт»), а не
   * застрявший сырой ввод мимо Стража.
   */
  private paste: PasteInFlight | undefined;

  /**
   * nonce маркера (тикет 14): 128 бит на каждый shell-канал. Реинжект после
   * su/sudo -i отправляет ту же настройку — новый шелл печатает тот же nonce.
   * Параметр — только для тестов.
   */
  constructor(private readonly nonce: string = randomBytes(16).toString('hex')) {
    this.breadcrumbParser = new BreadcrumbParser(nonce);
  }

  /** Разобрать очередной кусок вывода сервера. */
  feed(chunk: string): ShellIntegrationResult {
    const result = emptyResult();
    const raw = this.stripPendingEcho(chunk);
    const { pieces, marks } = this.breadcrumbParser.push(raw);

    if (!this.setupSent) {
      // MOTD ещё идёт — настройка уходит после паузы в выводе; таймер
      // перезаводится на каждый чанк, пока настройка не отправлена.
      result.timerActions.push({ timer: 'setup-silence', action: 'schedule', ms: SETUP_SILENCE_MS });
    }

    const effective = this.echoGate.filter(pieces, marks.length);
    const display = effective.join('');
    result.display = display;

    if (this.reinjectArmed) {
      if (marks.length > 0) {
        this.disarmReinject(result);
      } else {
        this.reinjectTail = (this.reinjectTail + display).slice(-256);
        result.timerActions.push({ timer: 'reinject', action: 'cancel' });
        if (!endsWithInputPrompt(this.reinjectTail)) {
          result.timerActions.push({ timer: 'reinject', action: 'schedule', ms: REINJECT_SILENCE_MS });
        }
      }
    }

    // Приписываем вывод СВОЕМУ маркеру: effective[i] — то, что пришло между
    // (i-1)-м и i-м маркером в этом чанке (несколько маркеров могут прийти
    // в одном chunk).
    for (let i = 0; i < marks.length; i++) {
      this.appendOutput(effective[i] ?? '');
      const mark = marks[i]!;
      this.awaitingFirstMarkAfterSetup = false;
      this.lastCrumb = mark.crumb;
      result.events.push({ kind: 'breadcrumb', crumb: mark.crumb, atPrompt: this.atPromptAfterMark(result), synthetic: false });
      this.handleCommandFinished(mark.exitCode, result);
      this.passwordPromptActive = false;
      this.outputTail = '';
      this.integrationUnconfirmed = false;
      this.promptGuessArmed = false;
    }
    const afterLastMark = effective[effective.length - 1] ?? '';
    this.appendOutput(afterLastMark);
    if (this.paste && afterLastMark) this.checkPasteEcho(this.paste, afterLastMark, result);

    // TERM-09: явный запрос пароля — событие только на нарастающем фронте.
    // Смотрим лишь вывод после последнего маркера: запрос до маркера уже
    // отвечен, а событие обязано идти ПОСЛЕ breadcrumb того же чанка —
    // renderer по нему уходит из «на промпте» (многострочная вставка
    // `cd /tmp\nsudo …` приносит маркер и запрос одним чанком).
    if (afterLastMark) {
      this.outputTail = (this.outputTail + afterLastMark).slice(-256);
      // Тикет 27: без маркеров composer мог вернуться по ложной/REPL-догадке, а
      // запрос секрета бывает любым («Key:», «pass phrase:») — здесь сырой ввод
      // включает любая незавершённая строка на «:» (ответ программе идёт без
      // Стража). Следующая догадка по приглашению вернёт composer. С рабочей
      // интеграцией правило прежнее, точное (TERM-09). Подсказка «ввод скрыт»
      // показывается и на таком запросе (не больше 3 раз) — отдельный сигнал без
      // подсказки не стоит лишней ветки IPC.
      if (
        !this.passwordPromptActive &&
        (matchesPasswordPromptPattern(this.outputTail) || (this.integrationUnconfirmed && this.tailAsksForInput()))
      ) {
        this.passwordPromptActive = true;
        result.events.push({ kind: 'password-prompt' });
      }
      if (this.promptGuessArmed) this.schedulePromptGuess(result);
      // После догадки шелл на приглашении молчит до ввода; вывод снова на
      // приглашении («[1]+ Done») — ещё там, иной («Enter key:») — догадка была ложной.
      else if (this.integrationUnconfirmed) this.atOwnShellPrompt = this.tailEndsWithOwnShellPrompt();
    }

    return result;
  }

  /** Команда уходит на сервер (композер/Страж/каталог/сниппеты/история). */
  writeCommand(command: string, guardStatus?: GuardStatus): ShellIntegrationResult {
    // Активен запрос пароля — это ответ на него, а не команда: уходит сырым,
    // не трогая lastCommand (история, WIN-04, детектор) — HIST-07, §4 CLAUDE.md.
    // Renderer в этот момент уже не на промпте; сюда пароль попадает, только
    // если сигнал до него не дошёл.
    // То же во время многострочной вставки (тикет 18): строку набрали в ответ
    // программе из вставки, чей запрос PASSWORD_PROMPT_RE не узнал.
    if (this.passwordPromptActive || this.paste) return this.sendRawInput(`${command}\n`);
    const result = emptyResult();
    // Тикет 26: без маркеров строка не с приглашения шелла — ввод в программу,
    // а не команда: выполняется (и попадёт в историю) по-прежнему сама программа.
    if (!this.integrationUnconfirmed || this.atOwnShellPrompt) {
      this.lastCommand = command.trim();
      this.lastCommandStartedAt = Date.now();
      this.pendingGuardStatus = guardStatus;
      if (this.integrationUnconfirmed) this.outputSinceMark = '';
    }

    // Команда эскалации (su/sudo/вложенный shell) сменит процесс шелла и хук
    // интеграции пропадёт — взводим реинжект (только если интеграция вообще
    // работала: без первого маркера повтор настройки бессмысленен).
    if (this.setupSent && this.firstMarkSeen && isShellEscalationCommand(command)) {
      this.armReinject(result);
    }

    // BRD-05: статус-строка над breadcrumb. writeCommand зовётся только для
    // команды, отправленной с реального промпта (композер/Страж/каталог/
    // сниппеты/история) — сырой ввод внутри уже запущенной программы идёт
    // через sendRawInput и сюда не попадает.
    if (this.firstMarkSeen) {
      const program = detectInteractiveProgram(command);
      if (program) result.events.push({ kind: 'interactive-program', program });
    }

    this.pendingEcho = { text: `${command}\r\n`, armedAt: Date.now() };
    this.writeRaw(`${command}\n`, result);
    return result;
  }

  /** Сырой пользовательский ввод (прямой ввод в терминал, посимвольно или вставкой). */
  sendRawInput(data: string): ShellIntegrationResult {
    const result = emptyResult();
    const lines = data.split(/\r\n|\r|\n/).map((l) => l.trim());
    // Один перевод строки — его маркер и так последний, считать нечего.
    if (this.atPrompt && !this.paste && lines.length > 2) {
      this.paste = { lines, marksSeen: 0, echoTail: '', echoSeen: false };
    }
    this.writeRaw(data, result);
    return result;
  }

  /** Команда отправлена через writeCommand, но маркер её завершения (реальный
   *  cycle.ran, см. handleCommandFinished) ещё не пришёл (WIN-04). */
  isBusy(): boolean {
    return this.runningCommand() !== null;
  }

  /** Текст выполняющейся сейчас команды (WIN-04, для конкретного текста в
   *  диалоге закрытия — «команда X будет прервана», не безликое «команда»)
   *  — null, если сессия свободна. */
  runningCommand(): string | null {
    return this.lastCommand !== '' ? this.lastCommand : null;
  }

  /** Канал закрылся — накопленный с последнего маркера вывод (если есть) для
   *  сверки с базой паттернов 'ssh-connection' (nologin-shell и т.п.). */
  close(): ShellIntegrationResult {
    const result = emptyResult();
    if (this.outputSinceMark.trim()) {
      result.events.push({ kind: 'unmarked-output', output: this.outputSinceMark });
    }
    return result;
  }

  /** Таймер, заведённый по просьбе коробки, истёк. */
  tick(timer: ShellIntegrationTimer): ShellIntegrationResult {
    const result = emptyResult();
    switch (timer) {
      case 'setup-silence':
      case 'setup-cap':
        this.armSetupIfNeeded(result);
        break;
      case 'echo-flush': {
        // Страховка: маркер не пришёл (shell без bash/zsh) — показать
        // накопленное вместо того, чтобы молча его проглотить.
        const buffered = this.echoGate.flush();
        if (buffered) {
          result.display = buffered;
          this.appendOutput(buffered);
          this.outputTail = (this.outputTail + buffered).slice(-256);
        }
        // То же самое обстоятельство («настройка ушла, маркер за 3 сек. не
        // пришёл») сигналит и renderer'у — пора вернуться под защиту Стража.
        // Режим пароля это событие не снимает; снимет догадка по приглашению
        // (так закрыт и реинжект, сбросивший запрос пароля молча).
        if (this.awaitingFirstMarkAfterSetup) {
          result.events.push({ kind: 'integration-unconfirmed' });
          this.integrationUnconfirmed = true;
          // Тикет 26: команда до неподтверждения (su/sudo -i при реинжекте) не
          // записывается — её конца не дождаться, а в выводе эхо настройки с nonce.
          this.lastCommand = '';
          this.pendingGuardStatus = undefined;
          this.outputSinceMark = '';
          this.atOwnShellPrompt = this.tailEndsWithOwnShellPrompt();
          this.schedulePromptGuess(result);
        }
        break;
      }
      case 'reinject':
        this.handleReinjectTick(result);
        break;
      case 'prompt-guess':
        // ponytail: эвристика формы приглашения — нестандартный PS1 (без $#%>
        // в конце) оставляет сессию в сыром вводе, как до тикета 25; ложное
        // срабатывание (вывод затих на «>») уводит в набор под Стражем — в
        // безопасную сторону. Точнее — только маркер, т.е. рабочая интеграция.
        if (
          this.promptGuessArmed &&
          this.integrationUnconfirmed &&
          endsWithShellPrompt(stripTerminalControls(this.outputTail))
        ) {
          this.atOwnShellPrompt = this.tailEndsWithOwnShellPrompt();
          this.promptGuessArmed = false;
          this.passwordPromptActive = false;
          this.outputTail = '';
          result.events.push({ kind: 'prompt-guess' });
          if (this.atOwnShellPrompt) this.finishGuessedCommand(result);
        }
        break;
      case 'paste-echo':
        // Эха следующей строки не было — приглашение настоящее. Но не при
        // запросе пароля: из режима пароля выводит только настоящий маркер
        // (TERM-09), иначе набираемый пароль печатается открыто.
        // ponytail: строки вставки после запроса пароля больше не отслеживаются —
        // маркер su вернёт «на промпт» раньше времени, пока на следующем Enter
        // atPrompt не сбросится; держать paste значило бы рисковать застрявшим
        // сырым вводом после Ctrl+C.
        if (this.paste) {
          const pw = this.passwordPromptActive;
          this.paste = undefined;
          if (!pw && this.lastCrumb) {
            this.atPrompt = true;
            result.events.push({ kind: 'breadcrumb', crumb: this.lastCrumb, atPrompt: true, synthetic: true });
          }
        }
        break;
    }
    return result;
  }

  private handleCommandFinished(exitCode: number | null, result: ShellIntegrationResult): void {
    const output = stripTerminalControls(this.outputSinceMark);
    this.outputSinceMark = '';
    this.inputSinceMark = false;

    if (!this.firstMarkSeen) {
      this.firstMarkSeen = true;
      return;
    }

    // Маркер без Enter'а с прошлого маркера — перерисовка приглашения
    // (SIGWINCH/Ctrl+L/completion), а не завершение команды.
    const cycle = this.commandGate.consume();
    if (!cycle.ran) return;

    const command = this.lastCommand;
    const guardStatus = this.pendingGuardStatus;
    const durationMs = Date.now() - this.lastCommandStartedAt;
    this.lastCommand = '';
    this.pendingGuardStatus = undefined;

    result.events.push({
      kind: 'command-finished',
      command,
      exitCode,
      output,
      guardStatus,
      typed: cycle.typed,
      durationMs
    });
  }

  /** Тикет 27: незавершённая строка на «:» — запрос ввода, возможно секрета. */
  private tailAsksForInput(): boolean {
    return endsWithInputPrompt(stripTerminalControls(this.outputTail));
  }

  private tailEndsWithOwnShellPrompt(): boolean {
    return endsWithOwnShellPrompt(stripTerminalControls(this.outputTail));
  }

  /** Тикет 26: без маркеров конец команды — догадка о приглашении шелла. Exit
   *  code неизвестен (детектор и тост «упала» молчат), из вывода срезается само
   *  приглашение — его последняя строка. Сходство с handleCommandFinished
   *  намеренно не обобщено: там конец цикла решают маркер и CommandGate.
   *  ponytail: вывод без перевода строки в конце (`printf abc`) уходит вместе
   *  с приглашением — отделить их можно только маркером. */
  private finishGuessedCommand(result: ShellIntegrationResult): void {
    const output = stripTerminalControls(this.outputSinceMark);
    this.outputSinceMark = '';
    this.commandGate.reset();
    const command = this.lastCommand;
    if (!command) return;
    this.lastCommand = '';
    const guardStatus = this.pendingGuardStatus;
    this.pendingGuardStatus = undefined;
    result.events.push({
      kind: 'command-finished',
      command,
      exitCode: null,
      output: output.slice(0, output.lastIndexOf('\n') + 1),
      guardStatus,
      typed: true,
      // Догадка срабатывает через PROMPT_GUESS_MS тишины после приглашения.
      durationMs: Math.max(0, Date.now() - this.lastCommandStartedAt - PROMPT_GUESS_MS)
    });
  }

  /** Общее тело первичной отправки ввода и отправки команды: настройка уходит
   *  первой, если ещё не отправлена, дальше — сам ввод, с учётом кредита Enter. */
  private writeRaw(data: string, result: ShellIntegrationResult): void {
    this.armSetupIfNeeded(result);
    // ponytail: приглашение, пришедшее ПОСЛЕ первого нажатия клавиши, не отрезается.
    if (this.firstMarkSeen && !this.inputSinceMark) {
      this.inputSinceMark = true;
      this.outputSinceMark = '';
    }
    this.commandGate.noteInput(data);
    const newline = /[\r\n]/.test(data);
    if (newline) this.atPrompt = false;
    if (this.integrationUnconfirmed) {
      if (newline || data.includes('\x03')) {
        this.atOwnShellPrompt = false;
        // Строка ушла или прервана Ctrl+C. Судим только по выводу ПОСЛЕ неё:
        // у тихой команды (read -s) в хвосте осталось бы прошлое приглашение —
        // догадка посреди команды.
        this.outputTail = '';
        this.schedulePromptGuess(result);
      } else if (this.promptGuessArmed) {
        // Набор следующей строки уже идёт сырым — догадка разрезала бы её, и
        // Страж увидел бы только хвост. Ждём её Enter.
        this.promptGuessArmed = false;
        result.timerActions.push({ timer: 'prompt-guess', action: 'cancel' });
      }
    }
    result.toWrite += data;
  }

  /** Маркер пришёл: вернулся ли шелл на приглашение (см. paste). */
  private atPromptAfterMark(result: ShellIntegrationResult): boolean {
    const paste = this.paste;
    if (paste && ++paste.marksSeen < paste.lines.length - 1) {
      paste.echoTail = '';
      paste.echoSeen = false;
      result.timerActions.push({ timer: 'paste-echo', action: 'schedule', ms: PASTE_ECHO_WAIT_MS });
      return false;
    }
    if (this.paste) result.timerActions.push({ timer: 'paste-echo', action: 'cancel' });
    this.paste = undefined;
    this.atPrompt = true;
    return true;
  }

  /** Вывод после маркера непоследней строки: эхо строки вставки — шелл её
   *  выполняет, следующий маркер ждём без таймера; иной вывод (медленный PS1,
   *  свой PROMPT_COMMAND) отодвигает таймер. */
  private checkPasteEcho(paste: PasteInFlight, text: string, result: ShellIntegrationResult): void {
    if (paste.echoSeen || paste.marksSeen === 0) return;
    const tail = (paste.echoTail = (paste.echoTail + stripTerminalControls(text)).slice(-512));
    // Только строки, которые точно ещё не выполнялись: k маркеров — это не
    // меньше k строк. Иначе эхом сочли бы приглашение или вывод прошлой строки.
    // Начало и конец строки, а не вся она: длинную строку readline переносит
    // или прокручивает (horizontal-scroll), в эхе видна только часть.
    const echoed = paste.lines
      .slice(paste.marksSeen)
      .some(
        (l) =>
          l.length >= MIN_PASTE_FRAGMENT &&
          (tail.includes(l.slice(0, PASTE_FRAGMENT)) || tail.includes(l.slice(-PASTE_FRAGMENT)))
      );
    if (echoed) paste.echoSeen = true;
    result.timerActions.push(
      echoed
        ? { timer: 'paste-echo', action: 'cancel' }
        : { timer: 'paste-echo', action: 'schedule', ms: PASTE_ECHO_WAIT_MS }
    );
  }

  private schedulePromptGuess(result: ShellIntegrationResult): void {
    this.promptGuessArmed = true;
    result.timerActions.push({ timer: 'prompt-guess', action: 'schedule', ms: PROMPT_GUESS_MS });
  }

  private armSetupIfNeeded(result: ShellIntegrationResult): void {
    if (this.setupSent) return;
    this.setupSent = true;
    result.timerActions.push({ timer: 'setup-silence', action: 'cancel' });
    result.timerActions.push({ timer: 'setup-cap', action: 'cancel' });
    this.emitSetupWrite(result);
  }

  private handleReinjectTick(result: ShellIntegrationResult): void {
    if (!this.reinjectArmed) return;
    this.reinjectArmed = false;
    this.reinjectTail = '';
    this.emitSetupWrite(result);
  }

  /** Общее тело первичной настройки и реинжекта: подавление эха + страховка. */
  private emitSetupWrite(result: ShellIntegrationResult): void {
    // Реинжект придерживается, пока висит запрос ввода, — раз настройка
    // уходит, запрос пароля уже отвечен. Без сброса сессия, где маркер так и
    // не пришёл, слала бы все команды сырыми (writeCommand).
    this.passwordPromptActive = false;
    this.outputTail = '';
    this.echoGate.arm();
    this.awaitingFirstMarkAfterSetup = true;
    result.toWrite += shellIntegrationSetup(this.nonce);
    result.timerActions.push({ timer: 'echo-flush', action: 'schedule', ms: ECHO_FLUSH_TIMEOUT_MS });
  }

  private armReinject(result: ShellIntegrationResult): void {
    this.reinjectArmed = true;
    this.reinjectTail = '';
    result.timerActions.push({ timer: 'reinject', action: 'cancel' });
  }

  /** Отбой реинжекта: обычный маркер = старый шелл снова на промпте
   *  (эскалация сорвалась/завершилась). */
  private disarmReinject(result: ShellIntegrationResult): void {
    this.reinjectArmed = false;
    this.reinjectTail = '';
    result.timerActions.push({ timer: 'reinject', action: 'cancel' });
  }

  /** Накопление вывода между маркерами с тем же капом, что и раньше (ERR-01). */
  private appendOutput(text: string): void {
    if (!text) return;
    this.outputSinceMark += text;
    if (this.outputSinceMark.length > 65536) {
      this.outputSinceMark = this.outputSinceMark.slice(-65536);
    }
  }

  /** Вырезает из чанка вывода ожидаемое эхо только что отправленной команды
   *  (см. writeCommand). Хвост, разрезанный между чанками, докапливается через
   *  укороченный pendingEcho.text, как в BreadcrumbParser.pending. */
  private stripPendingEcho(raw: string): string {
    const pending = this.pendingEcho;
    if (!pending) return raw;
    if (Date.now() - pending.armedAt > PENDING_ECHO_TIMEOUT_MS) {
      this.pendingEcho = undefined;
      return raw;
    }
    if (raw.length === 0) return raw;
    if (raw.startsWith(pending.text)) {
      this.pendingEcho = undefined;
      return raw.slice(pending.text.length);
    }
    if (pending.text.startsWith(raw)) {
      this.pendingEcho = { text: pending.text.slice(raw.length), armedAt: pending.armedAt };
      return '';
    }
    // Не совпало (сервер прислал что-то раньше эха, echo выключен и т.п.) —
    // сдаёмся, реальный вывод важнее.
    this.pendingEcho = undefined;
    return raw;
  }
}
