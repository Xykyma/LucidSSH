import type { Breadcrumb } from '@shared/breadcrumb';
import type { InteractiveProgramName } from '@shared/interactivePrograms';
import { isInteractiveProgramName } from '@shared/interactivePrograms';
import { splitCompound } from '../guard/patterns';

/**
 * Shell integration для breadcrumb (BRD-04, §19 Security_Guide).
 *
 * После открытия shell в сессию отправляется СТАТИЧЕСКАЯ настройка
 * PROMPT_COMMAND (bash) / precmd (zsh), которая перед каждым приглашением
 * печатает маркер с текущими user/host/cwd/euid. Значения подставляет сам
 * удалённый shell из своих переменных — недоверенный текст в команду не
 * вставляется. Маркер начинается APC-последовательностью (ESC _ …), кончается
 * BEL (см. SESSION_END) и ВЫРЕЗАЕТСЯ из потока в main до попадания в xterm,
 * поэтому на экране не виден.
 *
 * Маркер несёт nonce сессии (тикет 14): маркер-образную последовательность
 * может напечатать любой вывод сервера (`cat` файла, лог, MOTD, `wall`), а
 * nonce знает только наш shell — он вшит литералом в настройку. Маркер без
 * nonce или с чужим вырезается, но ни на что не влияет.
 */

// Разделитель полей — Unit Separator (0x1f), не встречается в путях/именах.
const US = '\x1f';
// APC: ESC _  …  ESC \ (так кончаются чужие маркеры; наш — см. SESSION_END)
const APC_START = '\x1b_lucidssh';
const APC_END = '\x1b\\';
// Маркер нашей сессии кончается на BEL, а не на ESC \ (найдено на Alpine
// 20.10.2026): BusyBox ash с FEATURE_EDITING_FANCY_PROMPT разбирает
// \-последовательности в уже развёрнутом PS1, и `\` из ESC \ склеивался с первым
// символом приглашения пользователя (`\$` → `#`) — маркер без конца, хвост с
// nonce на экране, приглашение искажено. BEL ни один shell в PS1 не трогает.
// Чужие маркеры (без nonce) ищутся до первого ESC \ или BEL и просто вырезаются.
const SESSION_END = '\x07';
// Конец чужого маркера — первый из ESC \ или BEL; один проход вместо двух indexOf.
// eslint-disable-next-line no-control-regex
const FOREIGN_END_RE = /\x1b\\|\x07/g;

/**
 * Команда настройки интеграции. ТРИ строки (определение функции, диспетчер, вызов-сигнал);
 * отправляются одной pty-записью, shell читает их последовательно. `printf` с
 * фиксированным форматом — статическая строка. Префикс-пробел в начале каждой
 * строки не даёт командам попасть в историю при HISTCONTROL=ignorespace.
 *
 * Почему не одна строка (найдено на реальном Keenetic/Xkeen 10.07.2026):
 * редактор строки BusyBox обрезает интерактивный ввод по буферу
 * CONFIG_FEATURE_EDITING_MAX_LEN (на роутерах обычно 512). Слитная настройка
 * была 633 байта — ash принял ровно 511, кавычка PROMPT_COMMAND=" осталась
 * незакрытой, shell завис в PS2-продолжении, маркер не выполнился, и через
 * ECHO_FLUSH_TIMEOUT_MS сырое эхо вываливалось в терминал. Каждая строка
 * обязана оставаться < ~500 байт (см. тест на лимит).
 *
 * Экран НЕ очищается: MOTD сервера остаётся видимым сразу после подключения.
 * Эхо самой команды-настройки прячется на стороне main процесса (EchoGate
 * ниже): всё между отправкой настройки и первым маркером — это её эхо, оно
 * не пересылается в xterm. Финальный вызов `__lucidssh_mark` в конце строки —
 * детерминированный сигнал «эхо закончилось». (Прошлые попытки стирать эхо
 * ANSI-кодами на стороне сервера ломались о непредсказуемость readline —
 * см. docs/Ideas_Backlog.md.)
 *
 * POSIX-совместимость (найдено на реальном BusyBox/ash-сервере 08.07.2026):
 * `precmd_functions+=(...)` — bash/zsh-расширение (array-append), не валидный
 * POSIX-синтаксис. `ash`/`dash` разбирают грамматику ВСЕГО `if/else/fi` до
 * выполнения, включая недостижимую ветку — и падают с syntax error ещё до
 * `__lucidssh_mark` в конце строки, из-за чего маркер не приходит вовсе
 * (EchoGate тогда полагается на flush-таймаут, см. sessionManager.ts).
 * Обёрнуто в `eval '...'`: для внешнего парсера это просто eval с одним
 * quoted-словом, содержимое кавычек не разбирается как грамматика и не может
 * сломать парсинг ash — а выполнится оно только если сам eval будет вызван
 * (т.е. только в zsh, где ZSH_VERSION непуст).
 *
 * `nonce` — hex (см. ShellIntegrationSession), поэтому безопасен литералом в
 * формате printf: ни `%`, ни `\`, ни кавычек. Первая строка с ним ~350 байт.
 *
 * Все строки обёрнуты в проверку «printf — встроенная команда» (тикет 17, F3):
 * внешний /usr/bin/printf (mksh, OpenBSD ksh, BusyBox без ASH_PRINTF) получил
 * бы nonce в argv, а его видят в `ps` другие пользователи сервера. Без builtin
 * не определяется функция, не ставится хук и не вызывается финальный маркер —
 * сессия ведёт себя как с shell, который маркер не присылает. Проверка в
 * каждой строке своя: строки — независимые команды (см. выше про BusyBox).
 */
// `command -V` — POSIX. bash/zsh/dash/ash/ksh93: «printf is a shell builtin»;
// внешний printf — путь, оканчивающийся на /printf; функция/алиас — не builtin.
// bash переводит этот текст (gettext): на сервере с ru_RU без LC_ALL=C проверка
// молча выключила бы интеграцию. LC_ALL=C — присваиванием внутри подстановки:
// действует только в подоболочке, а gettext при локали C игнорирует LANGUAGE.
// Слово `case` не расщепляется — кавычки не нужны; stderr в ту же подстановку:
// сообщение об ошибке на «builtin» не кончается (байты экономятся под лимит).
const IF_PRINTF_BUILTIN = 'case $(LC_ALL=C;command -V printf 2>&1) in *builtin) ';

export const shellIntegrationSetup = (nonce: string): string =>
  // __lc=$? — код возврата последней команды снимается ПЕРВЫМ, до любых операций (ERR-01).
  // Разделитель US — октавой \037 ВНУТРИ формата printf (как \033 для ESC), НЕ сырым
  // байтом в команде: сырой 0x1f — это Ctrl+_, в интерактивном bash readline
  // выполняет его как undo и корёжит команду (на реальных серверах маркер
  // склеивался без разделителей и breadcrumb не работал; мок без readline это скрывал).
  // 5-е поле — SUDO_USER удалённого шелла: отличает root-через-sudo (амбер
  // «sudo», BRD-03) от настоящего root-логина (красный). sudo проставляет её
  // сам даже при env_reset; `su -` окружение чистит — там поле пустое → root.
  // $PWD — ПОСЛЕДНИМ, и за ним nonce ещё раз (тикет 17, F2): имя каталога задаёт
  // сервер. US в нём не сдвинет euid/exit (они левее), а ESC \ в нём не оборвёт
  // маркер: BreadcrumbParser ищет конец по «US nonce BEL».
  ` ${IF_PRINTF_BUILTIN}__lucidssh_mark() { __lc=$?; printf '\\033_lucidssh${nonce}\\037%s\\037%s\\037%s\\037%s\\037%s\\037%s\\037${nonce}\\007' ` +
  `"\${USER:-$(id -un 2>/dev/null)}" "\${HOSTNAME:-$(hostname 2>/dev/null)}" "$(id -u 2>/dev/null)" "$__lc" "\${SUDO_USER:-}" "$PWD"; };; esac\n` +
  ` ${IF_PRINTF_BUILTIN}if [ -n "$ZSH_VERSION" ]; then autoload -Uz add-zsh-hook 2>/dev/null; add-zsh-hook precmd __lucidssh_mark 2>/dev/null || eval 'precmd_functions+=(__lucidssh_mark)'; ` +
  // bash: маркер через PROMPT_COMMAND, НЕ через встраивание в PS1. Маркер в PS1
  // становится частью СТРОКИ приглашения: readline перепечатывает её при
  // SIGWINCH/Ctrl+L/completion — повторный маркер со старым $? (источник бага
  // с самопереоткрытием детектора ошибок), а невидимые APC-байты вне \[ \]
  // ломают readline'у подсчёт ширины промпта (глюки переноса длинных команд).
  // Вывод PROMPT_COMMAND в строку приглашения не входит и не перепечатывается.
  `elif [ -n "$BASH_VERSION" ]; then case "$PROMPT_COMMAND" in *__lucidssh_mark*) ;; *) PROMPT_COMMAND="__lucidssh_mark\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac; ` +
  // ash/dash (BusyBox, роутеры): ни PROMPT_COMMAND, ни precmd нет — остаётся
  // встраивание в PS1 ($(...) переразворачивается перед каждым приглашением;
  // найдено на реальном Keenetic/ash-сервере 09.07.2026). Повторные маркеры от
  // перерисовок приглашения отсекает CommandGate на стороне main.
  `else case "$PS1" in *__lucidssh_mark*) ;; *) PS1='$(__lucidssh_mark)'"$PS1";; esac; fi;; esac\n` +
  // Финальный вызов-сигнал — отдельной строкой: со своей проверкой вторая не влезла бы в лимит.
  ` ${IF_PRINTF_BUILTIN}__lucidssh_mark;; esac\n`;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/g;

/** Результат одного маркера: breadcrumb + код возврата последней команды. */
export interface ShellMark {
  crumb: Breadcrumb;
  exitCode: number | null;
}

/** Результат push: очищенный вывод целиком + он же кусками между маркерами. */
export interface ParseResult {
  cleaned: string;
  /**
   * Текст, разбитый по позициям маркеров: pieces[i] — до marks[i],
   * pieces[последний] — после последнего маркера. Всегда pieces.length ===
   * marks.length + 1. Нужен EchoGate, чтобы отбросить текст ДО первого маркера
   * (эхо настройки), не тронув текст после.
   */
  pieces: string[];
  marks: ShellMark[];
}

/**
 * Потоковый парсер маркеров: удерживает «хвост» на случай, если APC-маркер
 * разрезан между чанками. Возвращает очищенный вывод и распознанные маркеры.
 */
export class BreadcrumbParser {
  private pending = '';

  /** Начало и конец маркера, который печатает настройка ЭТОЙ сессии. */
  private readonly sessionMarkerStart: string;
  private readonly sessionMarkerEnd: string;

  /** nonce — тот же, что вшит в shellIntegrationSetup этой сессии. */
  constructor(private readonly nonce: string) {
    this.sessionMarkerStart = APC_START + nonce + US;
    this.sessionMarkerEnd = US + nonce + SESSION_END;
  }

  push(chunk: string): ParseResult {
    const buf = this.pending + chunk;
    this.pending = '';
    const marks: ShellMark[] = [];
    const pieces: string[] = [];
    let cur = '';
    // buf не мутирует: pos — начало необработанного хвоста. Каждый поиск идёт
    // строго вперёд от pos, а ближайший старт маркера сессии кэшируется
    // (nested) — вывод с тысячами ложных стартов стоит O(n), а не O(k·n).
    let pos = 0;
    let nested = -1;
    let nestedFrom = -1; // с какой позиции посчитан nested; -1 — ещё не искали

    for (;;) {
      const startIdx = buf.indexOf(APC_START, pos);
      if (startIdx === -1) break;
      // Маркер нашего shell кончается только на «US nonce BEL» (тикет 17):
      // ESC \ или BEL в имени каталога не обрывают его раньше — иначе в таком каталоге
      // хвост с nonce вываливался бы на экран, а приглашение не распознавалось
      // (и Страж бы молчал). Без nonce в начале — до первого ESC \ или BEL
      // (BEL — конец маркера другой сессии, например из `cat` записи терминала).
      const isSession = buf.startsWith(this.sessionMarkerStart, startIdx);
      let terminator = this.sessionMarkerEnd;
      let endIdx: number;
      if (isSession) {
        endIdx = buf.indexOf(terminator, startIdx);
      } else {
        // один проход вперёд до первого из ESC \ или BEL
        FOREIGN_END_RE.lastIndex = startIdx;
        const m = FOREIGN_END_RE.exec(buf);
        endIdx = m ? m.index : -1;
        terminator = m ? m[0] : APC_END;
      }
      // Начало настоящего маркера раньше конца текущего: текущий — висящее
      // начало без конца (подделка из `cat` или наш маркер, оборванный Ctrl+C).
      // Иначе он проглотил бы настоящий маркер вместе с приглашением. Вырезается
      // только начальная последовательность (у нашего обрубка — вместе с nonce):
      // что за ней — показывается как обычный вывод, а не пропадает.
      // nested == -1 после поиска означает «до конца буфера нет» — повторно не ищем.
      if (nestedFrom === -1 || (nested !== -1 && nested <= startIdx)) {
        nested = buf.indexOf(this.sessionMarkerStart, startIdx + 1);
        nestedFrom = startIdx + 1;
      }
      if (nested !== -1 && (endIdx === -1 || nested < endIdx)) {
        const startLen = isSession ? this.sessionMarkerStart.length : APC_START.length;
        cur += buf.slice(pos, startIdx);
        pos = startIdx + startLen;
        continue;
      }
      if (endIdx === -1) {
        // маркер не завершён — выводим всё до него, хвост оставляем на потом
        cur += buf.slice(pos, startIdx);
        this.pending = buf.slice(startIdx);
        // защита от бесконечного накопления мусора без завершителя; с запасом
        // на маркер с $PWD до PATH_MAX (4096), пришедший несколькими чанками
        if (this.pending.length > 8192) {
          cur += this.pending;
          this.pending = '';
        }
        pieces.push(cur);
        return { cleaned: pieces.join(''), pieces, marks };
      }
      cur += buf.slice(pos, startIdx);
      const markerEnd = endIdx + terminator.length;
      // тело — без `ESC _lucidssh` и BEL; «US nonce» в конце остаётся для parseMarker
      // (у чужого маркера срез неточен, но parseMarker его без nonce всё равно отвергнет)
      const mark = parseMarker(buf.slice(startIdx + APC_START.length, markerEnd - SESSION_END.length), this.nonce);
      if (mark) {
        marks.push(mark);
        pieces.push(cur);
        cur = '';
      }
      pos = markerEnd;
    }

    // Возможен незавершённый APC_START, разрезанный по последним байтам —
    // придержим небольшой хвост, если он выглядит как начало ESC-последовательности.
    const tailEsc = buf.lastIndexOf('\x1b');
    if (tailEsc >= pos && buf.length - tailEsc < APC_START.length && APC_START.startsWith(buf.slice(tailEsc))) {
      cur += buf.slice(pos, tailEsc);
      this.pending = buf.slice(tailEsc);
    } else {
      cur += buf.slice(pos);
    }
    pieces.push(cur);
    return { cleaned: pieces.join(''), pieces, marks };
  }
}

/**
 * Гейт подавления эха setup-команды (MOTD виден сразу, без прокрутки).
 *
 * Между отправкой shellIntegrationSetup и первым маркером поток содержит
 * только эхо самой настройки — arm() включает подавление, filter() копит этот
 * текст вместо пересылки в xterm. Первый маркер завершает подавление: эхо
 * отбрасывается, вместо него в xterm уходит `\r ESC[K` — стирает устаревшее
 * приглашение с текущей строки, чтобы новое (напечатанное shell после
 * настройки) не приклеилось к старому. flush() — страховка для shell без
 * bash/zsh (маркер не придёт): накопленное показывается, а не теряется.
 */
export class EchoGate {
  private suppressing = false;
  private buffer = '';

  get active(): boolean {
    return this.suppressing;
  }

  arm(): void {
    this.suppressing = true;
    this.buffer = '';
  }

  /**
   * Фильтр очередного чанка: возвращает массив той же длины, что и pieces —
   * i-й элемент - эффективное (после подавления эха) содержимое i-го куска.
   * join() всего результата даёт то же, что раньше возвращала единая строка;
   * поэлементно нужен sessionManager, чтобы верно приписать вывод СВОЕМУ
   * маркеру, когда в одном чанке их несколько (иначе весь текст чанка
   * достаётся только первому маркеру, а остальные получают пустой вывод и
   * ошибочно уходят в fallback детектора).
   */
  filter(pieces: string[], markCount: number): string[] {
    if (!this.suppressing) return pieces;
    if (markCount === 0) {
      this.buffer += pieces.join('');
      return pieces.map(() => '');
    }
    this.suppressing = false;
    this.buffer = '';
    return pieces.map((p, i) => (i === 0 ? '\r\x1b[K' : p));
  }

  /** Аварийный сброс по таймауту: вернуть накопленное, выключить подавление. */
  flush(): string {
    const buffered = this.buffer;
    this.buffer = '';
    this.suppressing = false;
    return buffered;
  }
}

/**
 * Гейт «команда действительно выполнялась» (баг: детектор переоткрывается сам).
 *
 * Маркер встроен в PS1, т.е. является частью СТРОКИ приглашения. Readline (bash)
 * перепечатывает приглашение при SIGWINCH, Ctrl+L и tab-completion — вместе с
 * APC-маркером и СТАРЫМ $?. Открытие/закрытие панели детектора меняет размер
 * xterm → resize pty → SIGWINCH → «новый» маркер со старым ненулевым exit code →
 * панель переоткрывается сама, по кругу. То же с пустым Enter: $? не сбрасывается.
 *
 * Отличительный признак настоящего завершения команды: с момента прошлого
 * маркера в pty был отправлен Enter (перерисовки происходят без ввода).
 * noteInput() считает Enter'ы («кредиты» — многострочная вставка даёт маркер на
 * каждую строку), consume() тратит кредит на маркер. Кредиты капятся: Enter'ы,
 * съеденные интерактивной программой (не shell'ом), не должны копиться вечно.
 */
export class CommandGate {
  private credits = 0;
  private hadContent = false;

  noteInput(data: string): void {
    const enters = data.match(/\r\n|\r|\n/g);
    if (enters) this.credits = Math.min(this.credits + enters.length, 20);
    if (/[^\s]/.test(data)) this.hadContent = true;
  }

  /**
   * Вызывается на каждый маркер. ran=false — перерисовка приглашения, команда
   * не выполнялась. typed=false при ran=true — «пустой» Enter без единого
   * печатного символа: команды не было, $? в маркере остался от предыдущей.
   */
  consume(): { ran: boolean; typed: boolean } {
    if (this.credits === 0) return { ran: false, typed: false };
    this.credits -= 1;
    const typed = this.hadContent;
    // Пока есть кредиты (многострочная вставка), введённый текст относится и к
    // следующим маркерам; сбрасываем признак только когда кредиты исчерпаны.
    if (this.credits === 0) this.hadContent = false;
    return { ran: true, typed };
  }

  /** Новый shell (переподключение) — прежний ввод не в счёт. */
  reset(): void {
    this.credits = 0;
    this.hadContent = false;
  }
}

/** body — содержимое маркера между `ESC _lucidssh` и завершающим BEL. */
function parseMarker(body: string, nonce: string): ShellMark | null {
  // Формат: nonce US u US h US euid US exit US sudoUser US pwd US nonce.
  // Путь задаёт сервер (имя каталога) — он последний: US в нём уходит в путь,
  // не сдвигая числовые поля; завершающий nonce подтверждает, что маркер
  // дочитан до конца, а не оборван ESC \ из того же имени (тикет 17). Каждый
  // маркер печатает настройка этой же сессии, поэтому старых форматов нет.
  const parts = body.split(US);
  if (!nonce || parts.length < 8 || parts[0] !== nonce || parts[parts.length - 1] !== nonce) return null;
  const [, username, host, euidStr = '', exitStr = '', sudoUser] = parts;
  if (!/^\d{1,10}$/.test(euidStr) || !/^\d{1,10}$/.test(exitStr)) return null;
  const path = parts.slice(6, -1).join(US);
  // sudo = root с сохранённым SUDO_USER удалённого шелла (5-е поле маркера);
  // root без него — настоящий root-логин или `su -` (окружение вычищено).
  const privilege: Breadcrumb['privilege'] =
    Number(euidStr) === 0 ? (sudoUser ? 'sudo' : 'root') : 'normal';
  // Даже настоящий маркер несёт текст сервера: каталог может называться как
  // угодно. Управляющие символы (C0, DEL, C1) из полей вырезаются: путь
  // попадает в `cd` по клику и в отображение breadcrumb.
  const clean = (field: string | undefined): string => (field ?? '').replace(CONTROL_CHARS_RE, '');
  const crumb: Breadcrumb = {
    username: clean(username).slice(0, 64),
    host: clean(host).slice(0, 128),
    path: clean(path).slice(0, 4096),
    privilege
  };
  return { crumb, exitCode: Number(exitStr) };
}

// ---------------------------------------------------------------------------
// Реинжект интеграции после эскалации привилегий (фикс BRD-03/04, 15.07.2026).
// su/sudo/вложенный shell — НОВЫЙ процесс без хука PROMPT_COMMAND (он не
// экспортируется, а sudo и так чистит окружение): маркеры перестают приходить,
// breadcrumb замирает, а renderer навсегда считает «выполняется программа» —
// Страж/детектор/история молча отключаются. Лечение: распознать команду
// эскалации при отправке и повторить настройку (с тем же nonce), когда новый шелл
// покажет промпт (см. ReinjectGate-логику в sessionManager.ts).
// ---------------------------------------------------------------------------

/** Шеллы, голый запуск которых теряет хук (вложенный bash — тот же баг). */
const SHELL_NAMES = new Set(['bash', 'sh', 'zsh', 'dash', 'ash', 'ksh']);
/** Флаги sudo/doas, принимающие отдельное значение следующим словом. */
const VALUE_FLAGS = new Set(['-u', '-g', '-p', '-U', '-C', '-D', '-R', '-T', '-t', '-h']);

/**
 * Команда, после которой текущий shell сменяется новым (эскалация или вложенный
 * shell). Консервативно: ложный пропуск = сегодняшнее поведение (интеграция
 * замирает), ложное срабатывание = видимый мусор настройки в чужом REPL —
 * поэтому произвольные `sudo <команда>` не считаются.
 */
export function isShellEscalationCommand(command: string): boolean {
  return splitCompound(command).some(isEscalationSegment);
}

/**
 * Запуск известной интерактивной программы (BRD-05) — в т.ч. с `sudo`-префиксом
 * или в составной команде (`cd /var && less log`, разбивается через
 * splitCompound). Возвращает первую распознанную программу среди сегментов
 * составной команды. Детекция ограничена фиксированным списком (§ ТЗ BRD-05) —
 * распознавание произвольного foreground-процесса не входит в это требование.
 */
export function detectInteractiveProgram(command: string): InteractiveProgramName | null {
  for (const segment of splitCompound(command)) {
    const words = segment.trim().split(/\s+/).filter((w) => w.length > 0);
    const head = words[0] === 'sudo' ? words[1] : words[0];
    if (!head) continue;
    const name = head.slice(head.lastIndexOf('/') + 1);
    if (isInteractiveProgramName(name)) return name;
  }
  return null;
}

function isEscalationSegment(segment: string): boolean {
  const words = segment.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words[0] === 'exec') words.shift(); // `exec su -` / `exec bash`

  let interactiveFlag = false;
  while (words[0] === 'sudo' || words[0] === 'doas') {
    words.shift();
    while (words[0]?.startsWith('-')) {
      const flag = words.shift()!;
      // -i (login shell) / -s (shell) — в т.ч. слитно: -iu, -su
      if (/^-[a-z]*[is]/.test(flag) || flag === '--login') interactiveFlag = true;
      // Флаг со значением следующим словом — в т.ч. слитный `-iu deploy`
      if (VALUE_FLAGS.has(flag) || /^-[a-z]*u$/i.test(flag) || flag === '--user') {
        words.shift();
      }
    }
  }

  if (words.length === 0) return interactiveFlag; // `sudo -i`, `sudo -s`
  const head = words[0]!;
  if (head === 'su') return true; // su / su - / su - user / sudo su …
  // Голый запуск шелла: без аргументов либо только -l/-i (`bash deploy.sh` — нет)
  const name = head.slice(head.lastIndexOf('/') + 1);
  if (!SHELL_NAMES.has(name)) return false;
  return words.slice(1).every((w) => w === '-l' || w === '-i' || w === '--login');
}

/**
 * Явные паттерны запроса пароля (статический список + русские варианты).
 * Экспорт: TERM-09 (подсказка «ввод скрыт») переиспользует этот же список.
 */
export const PASSWORD_PROMPT_RE =
  /(\[sudo\] password for [^\n]*|password[^\n]*:|пароль[^\n]*:|enter passphrase[^\n]*:)[ \t]*$/i;

/**
 * Хвост вывода похож на ожидание ввода (запрос пароля и т.п.) — реинжект
 * настройки нужно придержать, иначе её текст уйдёт как «пароль». Локале-
 * независимая эвристика: незавершённая строка, оканчивающаяся двоеточием
 * (промпты шеллов кончаются на #/$/%/>, запросы ввода — почти всегда на «:»).
 */
export function endsWithInputPrompt(output: string): boolean {
  const line = lastLine(output);
  if (line.endsWith(':')) return true;
  return PASSWORD_PROMPT_RE.test(line);
}

/** Последняя (незавершённая) строка вывода без хвостовых пробелов. */
function lastLine(output: string): string {
  return output.slice(output.lastIndexOf('\n') + 1).replace(/[ \t\r]+$/, '');
}

/**
 * Хвост вывода похож на приглашение шелла: последняя строка кончается на
 * $/#/%/> (тикет 25, сессия без маркеров). Запрос пароля кончается на «:» —
 * под форму не подходит. Вход — уже без управляющих последовательностей.
 */
export function endsWithShellPrompt(output: string): boolean {
  return /[$#%>]$/.test(lastLine(output));
}

/**
 * TERM-09: подсказка «ввод пароля скрыт» показывается только на известные,
 * явные приглашения — в отличие от endsWithInputPrompt (реинжект, BRD-03/04)
 * здесь НЕТ локале-независимой эвристики по «:» (произвольные приглашения
 * намеренно не распознаются, чтобы не подсказывать невпопад).
 */
export function matchesPasswordPromptPattern(output: string): boolean {
  return PASSWORD_PROMPT_RE.test(lastLine(output));
}

/**
 * Вырезает из захваченного вывода управляющие последовательности терминала:
 * OSC (ESC ] … BEL | ESC \), CSI (SGR, ESC[K) и прочие ESC-последовательности,
 * включая одиночный ESC в конце. CR, LF и TAB не трогает (HIST-09, ERR-06).
 * Регулярка линейна: у каждой альтернативы один неперекрывающийся класс символов,
 * незавершённый OSC не даёт совпадения и не перебирается заново (ограничение PR #73).
 */
const TERMINAL_CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b(?![[\]])[ -/]*[0-~]?|\x1b/g;

export function stripTerminalControls(text: string): string {
  return text.replace(TERMINAL_CONTROL_RE, '');
}
