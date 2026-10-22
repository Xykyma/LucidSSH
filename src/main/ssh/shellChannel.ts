import type { ClientChannel } from 'ssh2';
import { IPC } from '@shared/ipc';
import type { GuardStatus } from '@shared/history';
import { emit } from '../ipc/events';
import {
  ShellIntegrationSession,
  SETUP_CAP_MS,
  type ShellIntegrationEvent,
  type ShellIntegrationResult,
  type ShellIntegrationTimer,
  type TimerAction
} from './shellIntegrationSession';

/**
 * Владеет одним shell-потоком (TERM-01) и всей механикой вокруг него —
 * применением решений `ShellIntegrationSession`, именованными таймерами,
 * гейтингом PTY-resize (issue 11 / ADR-0005), отправкой команды и сырого
 * текста. Вынесено из sessionManager.ts, чтобы конвейер вывода можно было
 * проверить без полного подключения (issue 03 спеки,
 * `.scratch/shell-channel-extraction/spec.md`, ADR-0009).
 *
 * `ShellChannel` не знает про `ManagedSession` и ничего у Сессии не читает —
 * получает в конструкторе уже открытый `ClientChannel` (открытие потока и
 * обработка его ошибки остаются в openShell, sessionManager.ts) и сообщает
 * наружу через зависимости (`deps`). Два флага, переживающих пересоздание
 * канала при переподключении/эскалации (`everConnected` для NOTIF-01,
 * `shellUnavailable` для отказа от автопереподключения), остаются полями
 * `ManagedSession` — канал их не хранит, только сигналит через `onClosed`/
 * `onShellUnavailable`.
 */

export interface ShellChannelDeps {
  /** commandReport.handleCommandFinished — личность сессии уже вшита вызывающей стороной. */
  onCommandFinished: (event: Extract<ShellIntegrationEvent, { kind: 'command-finished' }>) => void;
  /** commandReport.checkShellUnavailable — true, если распознан паттерн scope 'ssh-connection'. */
  onUnmarkedOutput: (output: string) => boolean;
  /** Канал закрылся с распознанной ssh-connection-ошибкой — автопереподключение бессмысленно. */
  onShellUnavailable: () => void;
  /** Поток закрылся (по любой причине) — сторона подключения останавливает дашборд и т.п. */
  onClosed: () => void;
}

export interface ShellChannelOptions {
  sessionId: string;
  stream: ClientChannel;
  /** Размер, с которым уже открыт PTY (см. client.shell(...) в openShell) —
   *  ptyCols/ptyRows синхронизируются с ним сразу, а не с дефолтом 80×24. */
  cols: number;
  rows: number;
  deps: ShellChannelDeps;
}

export class ShellChannel {
  private readonly sessionId: string;
  private readonly stream: ClientChannel;
  private readonly deps: ShellChannelDeps;
  private readonly shellIntegration: ShellIntegrationSession;
  private readonly shellTimers: Partial<Record<ShellIntegrationTimer, NodeJS.Timeout>> = {};

  private cols: number;
  private rows: number;
  /** Последний размер, реально применённый к PTY через setWindow (issue 11 /
   *  ADR-0005) — отдельно от cols/rows, которые обновляются на каждый запрос
   *  от renderer независимо от того, дошёл ли он до PTY. */
  private ptyCols: number;
  private ptyRows: number;
  /** Идёт ли сейчас известная fullscreen-интерактивная программа (BRD-05/06). */
  private interactiveProgramActive = false;

  constructor(opts: ShellChannelOptions) {
    this.sessionId = opts.sessionId;
    this.stream = opts.stream;
    this.deps = opts.deps;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.ptyCols = opts.cols;
    this.ptyRows = opts.rows;
    this.shellIntegration = new ShellIntegrationSession();

    // Вывод сервера проходит через ShellIntegrationSession: APC-маркеры
    // вырезаются (в xterm не попадают), из них формируется breadcrumb
    // (BRD-04) и отслеживается exit code для детектора ошибок (ERR-01).
    this.stream.on('data', (data: Buffer) => {
      this.applyResult(this.shellIntegration.feed(data.toString('utf8')));
    });
    this.stream.stderr?.on('data', (data: Buffer) => {
      emit(IPC.evTerminalData, this.sessionId, data.toString('utf8'));
    });
    this.stream.on('close', () => {
      this.clearAllShellTimers();
      this.deps.onClosed();
      this.applyResult(this.shellIntegration.close());
    });

    // Кап на случай сервера без MOTD/приглашения: настройка уйдёт даже если
    // данных от сервера не было и silence-таймер не взводился. Единственный
    // таймер, который коробка не может попросить сама — её интерфейс не
    // включает «канал открылся».
    this.applyTimerActions([{ timer: 'setup-cap', action: 'schedule', ms: SETUP_CAP_MS }]);
  }

  /** Для listSessions()/busySessions() (WIN-04) — какая команда сейчас выполняется. */
  runningCommand(): string | null {
    return this.shellIntegration.runningCommand();
  }

  /** Остановить именованные таймеры при принудительном уничтожении сессии
   *  (destroySession) — не дожидаясь события 'close' от потока, который
   *  сейчас же будет разрушен вместе с Client. Идемпотентно с обработчиком
   *  'close' (clearShellTimer не падает на уже снятом таймере). */
  dispose(): void {
    this.clearAllShellTimers();
  }

  /** Отправка ввода пользователя — сырая, без Стража (GUARD-02/04, решение —
   *  на стороне вызывающего). */
  sendInput(data: string): void {
    this.applyResult(this.shellIntegration.sendRawInput(data));
  }

  /** Отправка ОДОБРЕННОЙ Стражем команды (submitCommand/confirmDangerousCommand,
   *  GUARD-02) — подавляет эхо именно этой команды, см. sessionManager.ts. */
  sendCommandLine(command: string, guardStatus?: GuardStatus): void {
    this.applyResult(this.shellIntegration.writeCommand(command, guardStatus));
  }

  /**
   * Изменение размера PTY под размер xterm (TERM-xx). Гейтинг по cols
   * (issue 11 / ADR-0005): панели вроде ErrorDetector/HintBar меняют только
   * высоту (rows) контейнера xterm, не ширину — реальный PTY-resize
   * (SIGWINCH-эффект, приводящий к перерисовке приглашения на удалённой
   * стороне) в этом случае пропускается, если сейчас не идёт известная
   * fullscreen-программа, которой точный rows нужен для корректной отрисовки.
   * При изменении cols resize применяется всегда, как раньше.
   */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;

    const colsChanged = cols !== this.ptyCols;
    const rowsChanged = rows !== this.ptyRows;
    if (!colsChanged && !rowsChanged) return;
    if (!colsChanged && !this.interactiveProgramActive) return;

    this.applyRealResize(cols, rows);
  }

  /** Реально применяет размер к PTY-каналу и запоминает его как последний
   *  применённый (ADR-0005) — единственное место, где вызывается setWindow. */
  private applyRealResize(cols: number, rows: number): void {
    this.ptyCols = cols;
    this.ptyRows = rows;
    this.stream.setWindow(rows, cols, 0, 0);
  }

  /** Применяет решение ShellIntegrationSession: пишет в provод, показывает
   *  текст в терминале, (пере)заводит/отменяет таймеры, разбирает события —
   *  единственное место, где коробка встречается с реальным IO. */
  private applyResult(result: ShellIntegrationResult): void {
    if (result.toWrite) this.stream.write(result.toWrite);
    if (result.display) emit(IPC.evTerminalData, this.sessionId, result.display);
    this.applyTimerActions(result.timerActions);
    for (const event of result.events) {
      this.handleShellIntegrationEvent(event);
    }
  }

  private clearShellTimer(timer: ShellIntegrationTimer): void {
    const handle = this.shellTimers[timer];
    if (handle) {
      clearTimeout(handle);
      delete this.shellTimers[timer];
    }
  }

  private clearAllShellTimers(): void {
    for (const timer of Object.keys(this.shellTimers) as ShellIntegrationTimer[]) {
      this.clearShellTimer(timer);
    }
  }

  /** Заводит/отменяет именованные таймеры коробки — она сама «рук не имеет»
   *  (см. shellIntegrationSession.ts). По истечении таймер зовёт box.tick(). */
  private applyTimerActions(actions: TimerAction[]): void {
    for (const action of actions) {
      this.clearShellTimer(action.timer);
      if (action.action !== 'schedule') continue;
      this.shellTimers[action.timer] = setTimeout(() => {
        delete this.shellTimers[action.timer];
        this.applyResult(this.shellIntegration.tick(action.timer));
      }, action.ms);
    }
  }

  private handleShellIntegrationEvent(event: ShellIntegrationEvent): void {
    switch (event.kind) {
      case 'breadcrumb':
        // breadcrumb приходит на каждое приглашение, в т.ч. на marker-перерисовку
        // без Enter (SIGWINCH-эффект, см. shellIntegrationSession.test.ts) — во
        // время реальной fullscreen-программы (vim/htop/...) этот маркер не
        // приходит вовсе, так что сброс здесь корректно ловит именно выход из
        // программы (ADR-0005), а не путает её с обычным промптом.
        this.interactiveProgramActive = false;
        emit(IPC.evBreadcrumb, this.sessionId, event.crumb, event.atPrompt, event.synthetic);
        break;
      case 'command-finished':
        this.deps.onCommandFinished(event);
        break;
      case 'password-prompt':
        emit(IPC.evPasswordPrompt, this.sessionId);
        break;
      case 'unmarked-output':
        if (this.deps.onUnmarkedOutput(event.output)) this.deps.onShellUnavailable();
        break;
      case 'integration-unconfirmed':
        emit(IPC.evIntegrationUnconfirmed, this.sessionId);
        break;
      case 'prompt-guess':
        emit(IPC.evPromptGuess, this.sessionId);
        break;
      case 'interactive-program':
        this.interactiveProgramActive = true;
        // Досылаем ранее пропущенный (только-rows) resize (ADR-0005): если
        // ErrorDetector/HintBar были открыты до запуска программы, PTY мог
        // остаться на устаревшем rows — fullscreen-программе нужен точный
        // размер сразу при старте, иначе она отрисуется некорректно.
        if (this.cols !== this.ptyCols || this.rows !== this.ptyRows) {
          this.applyRealResize(this.cols, this.rows);
        }
        emit(IPC.evInteractiveProgram, this.sessionId, event.program);
        break;
    }
  }
}
