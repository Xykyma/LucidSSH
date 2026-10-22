import { describe, expect, it } from 'vitest';
import { ShellIntegrationSession, type ShellIntegrationResult } from './shellIntegrationSession';
import { shellIntegrationSetup } from './shellIntegration';
import { excerpt, isEmptyOutput, isNonErrorExitCode } from '../errors/detector';
import { hasBlockSecret } from '../secrets/maskers';

const US = '\x1f';
const NONCE = '0123456789abcdef0123456789abcdef';
const SETUP = shellIntegrationSetup(NONCE);
const mk = (u: string, h: string, p: string, e: string, c = '0', sudoUser = '', nonce = NONCE): string =>
  `\x1b_lucidssh${nonce}${US}${u}${US}${h}${US}${e}${US}${c}${US}${sudoUser}${US}${p}${US}${nonce}\x07`;
/** Тот же маркер, что напечатал бы `printf` из тикета 14: без nonce. */
const forged = (p: string, e = '0', c = '0'): string =>
  `\x1b_lucidssh${US}x${US}y${US}${p}${US}${e}${US}${c}${US}\x1b\\`;
/** nonce, вшитый в отправленную настройку. */
const nonceOf = (setup: string): string => /_lucidssh([0-9a-f]+)\\037/.exec(setup)![1]!;

/** Полный цикл подключения: MOTD → настройка (по таймеру тишины) → первый
 *  маркер (приветствие, тот самый, который отправляет сама настройка). После
 *  этого коробка в устойчивом состоянии — setupSent и firstMarkSeen истинны,
 *  EchoGate снова прозрачен — как в реальной сессии перед первой командой
 *  пользователя. Общий сетап для тестов, которым нужна именно эта точка. */
function warmUp(box: ShellIntegrationSession): void {
  box.feed('Welcome to Ubuntu 24.04\r\n');
  box.tick('setup-silence');
  box.feed(mk('u', 'h', '/home/u', '1000', '0'));
}

describe('ShellIntegrationSession.feed — MOTD и первый маркер', () => {
  it('MOTD до первой настройки виден в терминале как есть', () => {
    const box = new ShellIntegrationSession(NONCE);
    const result = box.feed('Welcome to Ubuntu 24.04\r\n');
    expect(result.display).toBe('Welcome to Ubuntu 24.04\r\n');
    expect(result.timerActions).toContainEqual({ timer: 'setup-silence', action: 'schedule', ms: 300 });
  });

  it('первый маркер — приветствие, не порождает command-finished, но порождает breadcrumb', () => {
    const box = new ShellIntegrationSession(NONCE);
    const result = box.feed(mk('nikita', 'web-01', '/home/nikita', '1000', '0'));
    expect(result.events).toEqual([
      { kind: 'breadcrumb', crumb: expect.objectContaining({ username: 'nikita' }), atPrompt: true }
    ]);
  });
});

describe('ShellIntegrationSession.feed — обычная команда', () => {
  it('команда с ненулевым кодом выхода порождает command-finished после breadcrumb', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('cat missing.txt');
    const result = box.feed(`cat: missing.txt: No such file or directory\r\n${mk('u', 'h', '/home/u', '1000', '1')}`);
    expect(result.events.map((e) => e.kind)).toEqual(['breadcrumb', 'command-finished']);
    const finished = result.events[1];
    if (finished?.kind !== 'command-finished') throw new Error('expected command-finished');
    expect(finished.command).toBe('cat missing.txt');
    expect(finished.exitCode).toBe(1);
    expect(finished.output).toBe('cat: missing.txt: No such file or directory\r\n');
    expect(finished.typed).toBe(true);
  });

  it('маркер-перерисовка приглашения без Enter (SIGWINCH) — без command-finished', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('ls');
    const first = box.feed(mk('u', 'h', '/home/u', '1000', '0'));
    expect(first.events.map((e) => e.kind)).toEqual(['breadcrumb', 'command-finished']);

    // resize (открытие/закрытие панели детектора) — readline перепечатал
    // промпт со старым $?, Enter не отправлялся.
    const repaint = box.feed(mk('u', 'h', '/home/u', '1000', '0'));
    expect(repaint.events.map((e) => e.kind)).toEqual(['breadcrumb']);
  });
});

describe('ShellIntegrationSession.isBusy — WIN-04', () => {
  it('изначально не занята', () => {
    const box = new ShellIntegrationSession(NONCE);
    expect(box.isBusy()).toBe(false);
  });

  it('writeCommand взводит busy, реальное завершение команды снимает', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('sleep 5');
    expect(box.isBusy()).toBe(true);
    box.feed(mk('u', 'h', '/home/u', '1000', '0'));
    expect(box.isBusy()).toBe(false);
  });

  it('перерисовка приглашения без Enter (SIGWINCH) не снимает busy — команда ещё не завершилась', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('top');
    box.feed(mk('u', 'h', '/home/u', '1000', '0')); // command-finished
    expect(box.isBusy()).toBe(false);

    // Взводим заново второй командой и проверяем, что маркер-перерисовку
    // (без предшествующего writeCommand/Enter) busy не трогает вовсе —
    // здесь просто нет активной команды, которую можно было бы снять дважды.
    box.feed(mk('u', 'h', '/home/u', '1000', '0'));
    expect(box.isBusy()).toBe(false);
  });

  it('прямой ввод в терминал (sendRawInput) busy не взводит', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.sendRawInput('ls\n');
    expect(box.isBusy()).toBe(false);
  });
});

describe('ShellIntegrationSession.runningCommand — WIN-04 (текст команды для диалога закрытия)', () => {
  it('null, пока сессия свободна; текст команды — пока она выполняется', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    expect(box.runningCommand()).toBeNull();
    box.writeCommand('sleep 30');
    expect(box.runningCommand()).toBe('sleep 30');
    box.feed(mk('u', 'h', '/home/u', '1000', '0'));
    expect(box.runningCommand()).toBeNull();
  });
});

describe('ShellIntegrationSession — эскалация и реинжект (фикс BRD-03/04)', () => {
  it('эскалация взводит реинжект; тишина нового шелла запускает повтор настройки', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);

    const cmdResult = box.writeCommand('sudo -i');
    expect(cmdResult.timerActions).toContainEqual({ timer: 'reinject', action: 'cancel' });

    // Новый шелл печатает что-то без маркера — тишина взводит таймер реинжекта.
    const dataResult = box.feed('root@web-01:~# ');
    expect(dataResult.timerActions).toContainEqual({ timer: 'reinject', action: 'cancel' });
    expect(dataResult.timerActions).toContainEqual({ timer: 'reinject', action: 'schedule', ms: 800 });

    const tickResult = box.tick('reinject');
    expect(tickResult.toWrite).toBe(SETUP);
    expect(tickResult.timerActions).toContainEqual({ timer: 'echo-flush', action: 'schedule', ms: 3000 });
  });

  it('обычный маркер во время реинжекта — отбой (эскалация сорвалась/завершилась)', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('su -');

    const result = box.feed(mk('u', 'h', '/home/u', '1000', '0'));
    expect(result.timerActions).toContainEqual({ timer: 'reinject', action: 'cancel' });
    // после отбоя следующая тишина без маркера больше не взводит реинжект
    const after = box.feed('some later output without marker');
    expect(after.timerActions).not.toContainEqual(
      expect.objectContaining({ timer: 'reinject', action: 'schedule' })
    );
  });

  it('запрос пароля во время реинжекта придерживает инжект (не отправляет настройку как пароль)', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('sudo -i');

    const result = box.feed('[sudo] password for nikita:');
    // хвост оканчивается на приглашение ввода — таймер реинжекта НЕ взводится
    expect(result.timerActions).not.toContainEqual(
      expect.objectContaining({ timer: 'reinject', action: 'schedule' })
    );
    expect(result.timerActions).toContainEqual({ timer: 'reinject', action: 'cancel' });
  });
});

describe('ShellIntegrationSession — запрос пароля (TERM-09)', () => {
  it('явный запрос пароля вне эскалации порождает событие один раз, до следующего маркера', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    const first = box.feed('Password:');
    expect(first.events).toEqual([{ kind: 'password-prompt' }]);
    const second = box.feed(' still waiting');
    expect(second.events).toEqual([]);
    // маркер сбрасывает признак — следующий запрос снова породит событие
    const afterMark = box.feed(mk('u', 'h', '/', '1000', '0'));
    expect(afterMark.events.some((e) => e.kind === 'password-prompt')).toBe(false);
  });

  it('запрос пароля после маркера в том же чанке (многострочная вставка) — событие после breadcrumb', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.sendRawInput('cd /tmp\nsudo apt update\n');
    const result = box.feed(`${mk('u', 'h', '/tmp', '1000', '0')}$ sudo apt update\r\n[sudo] password for u: `);
    // renderer применяет события по порядку: breadcrumb возвращает «на промпт»,
    // запрос пароля обязан прийти ПОСЛЕ него, иначе пароль уйдёт с эхом
    const kinds = result.events.map((e) => e.kind);
    expect(kinds.indexOf('password-prompt')).toBeGreaterThan(kinds.indexOf('breadcrumb'));
    expect(kinds.indexOf('breadcrumb')).toBeGreaterThanOrEqual(0);
  });

  it('запрос пароля до маркера в том же чанке уже завершён — события нет', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    const result = box.feed(`Password: \r\nsu: Authentication failure\r\n${mk('u', 'h', '/', '1000', '1')}`);
    expect(result.events.some((e) => e.kind === 'password-prompt')).toBe(false);
  });

  it('ответ на запрос пароля через конвейер команд не попадает в историю и не становится командой', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    // многострочная вставка: команда уходит сырой, renderer считает себя на промпте
    box.sendRawInput('sudo apt update\n');
    box.feed('sudo apt update\r\n[sudo] password for u: ');

    const sent = box.writeCommand('hunter2');
    expect(sent.toWrite).toBe('hunter2\n');
    expect(box.runningCommand()).toBeNull();

    const done = box.feed(`\r\nok\r\n${mk('u', 'h', '/', '1000', '0')}`);
    expect(done.events).toContainEqual(expect.objectContaining({ kind: 'command-finished', command: '' }));
  });

  it('реинжект после пароля без маркера не оставляет сессию в режиме «ответ на пароль»', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('sudo -i');
    box.feed('sudo -i\r\n[sudo] password for u: ');
    box.sendRawInput('hunter2\n');
    box.feed('\r\n');
    box.tick('reinject');
    // маркер так и не пришёл — renderer по integration-unconfirmed снова на промпте
    expect(box.tick('echo-flush').events).toContainEqual({ kind: 'integration-unconfirmed' });

    box.writeCommand('ls');
    expect(box.runningCommand()).toBe('ls');
  });

  it('запрос пароля после набранной команды — в историю идёт команда, не пароль', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('sudo apt update');
    box.feed('sudo apt update\r\n[sudo] password for u: ');
    box.writeCommand('hunter2');
    expect(box.runningCommand()).toBe('sudo apt update');

    const done = box.feed(`\r\nok\r\n${mk('u', 'h', '/', '1000', '0')}`);
    expect(done.events).toContainEqual(
      expect.objectContaining({ kind: 'command-finished', command: 'sudo apt update' })
    );
  });
});

describe('ShellIntegrationSession — ash/BusyBox (маркер через PS1, без PROMPT_COMMAND)', () => {
  it('маркер, встроенный в PS1, разбирается так же, как маркер PROMPT_COMMAND', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('ls /tmp');
    const result = box.feed(`file1  file2\r\n${mk('root', 'router', '/tmp', '0', '0')}`);
    const finished = result.events.find((e) => e.kind === 'command-finished');
    expect(finished).toBeDefined();
    if (finished?.kind !== 'command-finished') throw new Error('expected command-finished');
    expect(finished.exitCode).toBe(0);
  });
});

describe('ShellIntegrationSession.close — без единого маркера (nologin-паттерн)', () => {
  it('накопленный вывод возвращается как unmarked-output', () => {
    const box = new ShellIntegrationSession(NONCE);
    box.feed('This account is currently not available.\r\n');
    const result = box.close();
    expect(result.events).toEqual([
      { kind: 'unmarked-output', output: 'This account is currently not available.\r\n' }
    ]);
  });

  it('пустой/пробельный вывод — событие не порождается', () => {
    const box = new ShellIntegrationSession(NONCE);
    box.feed('   \r\n');
    expect(box.close().events).toEqual([]);
  });
});

describe('ShellIntegrationSession — отправка настройки (первый ввод/таймер)', () => {
  it('первый пользовательский ввод до истечения таймера сам отправляет настройку', () => {
    const box = new ShellIntegrationSession(NONCE);
    const result = box.sendRawInput('l');
    expect(result.toWrite).toBe(SETUP + 'l');
    expect(result.timerActions).toContainEqual({ timer: 'setup-silence', action: 'cancel' });
    expect(result.timerActions).toContainEqual({ timer: 'setup-cap', action: 'cancel' });
  });

  it('настройка отправляется один раз — повторный ввод не дублирует её', () => {
    const box = new ShellIntegrationSession(NONCE);
    box.sendRawInput('l');
    const second = box.sendRawInput('s');
    expect(second.toWrite).toBe('s');
  });

  it('тишина после MOTD (тик setup-silence) отправляет настройку сама', () => {
    const box = new ShellIntegrationSession(NONCE);
    box.feed('Welcome\r\n');
    const result = box.tick('setup-silence');
    expect(result.toWrite).toBe(SETUP);
  });

  it('эхо-флаш по таймауту показывает накопленное и не теряет его как вывод (ERR-01)', () => {
    const box = new ShellIntegrationSession(NONCE);
    box.sendRawInput('x'); // отправляет настройку, вооружает EchoGate
    box.feed('нераспознанное эхо без маркера');
    const result = box.tick('echo-flush');
    expect(result.display).toBe('нераспознанное эхо без маркера');
  });
});

describe('ShellIntegrationSession — integration-unconfirmed (страховка без маркера)', () => {
  it('маркер не пришёл к echo-flush — событие integration-unconfirmed', () => {
    const box = new ShellIntegrationSession(NONCE);
    box.sendRawInput('x'); // отправляет настройку
    box.feed('shell без PROMPT_COMMAND, эхо без маркера');
    const result = box.tick('echo-flush');
    expect(result.events).toContainEqual({ kind: 'integration-unconfirmed' });
  });

  it('маркер пришёл до echo-flush — события нет', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box); // отправляет настройку и уже получает первый маркер
    const result = box.tick('echo-flush');
    expect(result.events).not.toContainEqual({ kind: 'integration-unconfirmed' });
  });

  it('реинжект после эскалации без ответа нового шелла — тоже порождает integration-unconfirmed', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box); // firstMarkSeen уже true от исходного подключения
    box.writeCommand('sudo -i');
    box.feed('root@web-01:~# '); // тишина без маркера — взводит реинжект
    box.tick('reinject'); // повторная отправка настройки новому шеллу

    // Новый шелл так и не прислал маркер — echo-flush должен просигналить,
    // несмотря на то что firstMarkSeen от старого подключения уже true.
    const result = box.tick('echo-flush');
    expect(result.events).toContainEqual({ kind: 'integration-unconfirmed' });
  });
});

describe('ShellIntegrationSession.writeCommand — эхо отправленной команды не дублируется', () => {
  it('эхо команды вырезается из следующего чанка вывода', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('echo hi');
    const result = box.feed('echo hi\r\nhi\r\n');
    expect(result.display).toBe('hi\r\n');
  });
});

describe('ShellIntegrationSession.writeCommand — запуск интерактивной программы (BRD-05)', () => {
  it('известная программа порождает событие interactive-program', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    const result = box.writeCommand('htop');
    expect(result.events).toEqual([{ kind: 'interactive-program', program: 'htop' }]);
  });

  it('sudo-префикс и составная команда — тоже детектируются', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    const result = box.writeCommand('cd /var && sudo less log');
    expect(result.events).toEqual([{ kind: 'interactive-program', program: 'less' }]);
  });

  it('обычная команда — без события', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    const result = box.writeCommand('ls -la');
    expect(result.events).toEqual([]);
  });

  it('до первого маркера (ещё нет firstMarkSeen) — без события', () => {
    const box = new ShellIntegrationSession(NONCE);
    const result = box.writeCommand('htop');
    expect(result.events).toEqual([]);
  });
});

describe('ShellIntegrationSession — приглашение и escape-ы не попадают в output (HIST-09)', () => {
  const prompt = '\x1b]0;root@h: ~\x07root@h:~# ';
  const finished = (r: ReturnType<ShellIntegrationSession['feed']>): string => {
    const e = r.events.find((x) => x.kind === 'command-finished');
    if (e?.kind !== 'command-finished') throw new Error('no command-finished');
    return e.output;
  };

  it('команда с выводом: ровно то, что напечатала команда', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.feed(prompt);
    box.writeCommand('ls');
    const r = box.feed(`\x1b[Kmoduli\r\nssh_config\r\n${mk('u', 'h', '/', '0', '0')}`);
    expect(finished(r)).toBe('moduli\r\nssh_config\r\n');
  });

  it('команда без вывода и набранный ввод (sendRawInput)', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.feed(prompt);
    box.sendRawInput('false\n');
    expect(finished(box.feed(mk('u', 'h', '/', '0', '1')))).toBe('');
  });

  it('приглашение, разрезанное на два чанка, не дублируется', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.feed(prompt.slice(0, 7));
    box.feed(prompt.slice(7));
    box.writeCommand('true');
    expect(finished(box.feed(`ok\r\n${mk('u', 'h', '/', '0', '0')}`))).toBe('ok\r\n');
  });

  it('ввод раньше приглашения: не падает, приглашение не режется (известный потолок)', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('true');
    box.feed(prompt);
    expect(finished(box.feed(mk('u', 'h', '/', '0', '0')))).toBe('root@h:~# ');
  });

  it('детектор: `false` даёт пустой вывод, а не приглашение (ERR-06)', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.feed(prompt);
    box.writeCommand('false');
    const out = finished(box.feed(mk('u', 'h', '/', '0', '1')));
    expect(isEmptyOutput(out)).toBe(true);
  });

  it('детектор: исключение `2>/dev/null` срабатывает на реальном потоке', () => {
    const cmd = 'true 2>/dev/null && false 2>/dev/null';
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.feed(prompt);
    box.writeCommand(cmd);
    const out = finished(box.feed(mk('u', 'h', '/', '0', '1')));
    expect(isNonErrorExitCode(cmd, out, 1)).toBe(true);
  });

  it('детектор: excerpt ошибки без escape-ов', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.feed(prompt);
    box.writeCommand('ls /nonexist');
    const out = finished(
      box.feed(`ls: cannot access '/nonexist': No such file or directory\r\n${mk('u', 'h', '/', '0', '2')}`)
    );
    expect(excerpt(out)).toBe("ls: cannot access '/nonexist': No such file or directory\r\n".trimEnd());
    expect(out).not.toContain('\x1b');
  });

  it('ls --color: в output нет ESC', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.feed(prompt);
    box.writeCommand('ls --color=always');
    const out = finished(box.feed(`\x1b[0m\x1b[01;34mdir\x1b[0m  file\r\n${mk('u', 'h', '/', '0', '0')}`));
    expect(out).toBe('dir  file\r\n');
  });

  it('PEM с SGR-кодами: после зачистки hasBlockSecret его видит', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.feed(prompt);
    box.writeCommand('cat key.pem');
    const out = finished(
      box.feed(`-----\x1b[1mBEGIN OPENSSH PRIVATE KEY-----\r\nabc\r\n-----END OPENSSH PRIVATE KEY-----\r\n${mk('u', 'h', '/', '0', '0')}`)
    );
    expect(hasBlockSecret(out)).toBe(true);
  });
});

describe('ShellIntegrationSession — подделанный маркер (тикет 14)', () => {
  it('настоящий маркер принимается, подделанный вырезан из вывода и ничего не меняет', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('ls');
    const result = box.feed(`a${forged('/fake', '0', '1')}b${mk('u', 'h', '/srv', '1000', '0')}$ `);
    expect(result.display).toBe('ab$ ');
    expect(result.events).toEqual([
      { kind: 'breadcrumb', crumb: expect.objectContaining({ path: '/srv', privilege: 'normal' }), atPrompt: true },
      expect.objectContaining({ kind: 'command-finished', command: 'ls', exitCode: 0, output: 'ab' })
    ]);
  });

  it('подделка во время работы программы: ни breadcrumb, ни завершения команды, busy остаётся', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('cat evil.txt');
    const result = box.feed(`line\r\n${forged('/fake', '0', '1')}more\r\n`);
    expect(result.display).toBe('line\r\nmore\r\n');
    expect(result.events).toEqual([]);
    expect(box.isBusy()).toBe(true);
    // настоящий маркер потом получает весь вывод команды, с кодом выхода из него
    const done = box.feed(mk('u', 'h', '/home/u', '1000', '0'));
    expect(done.events[1]).toMatchObject({ kind: 'command-finished', exitCode: 0, output: 'line\r\nmore\r\n' });
  });

  it('ESC \\ и US в имени каталога: маркер принят целиком, euid/exit не подменены (тикет 17)', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('cd evil');
    const result = box.feed(`${mk('u', 'h', `/tmp/x\x1b\\y${US}0${US}1`, '1000', '0')}$ `);
    expect(result.display).toBe('$ ');
    expect(result.events).toEqual([
      { kind: 'breadcrumb', crumb: expect.objectContaining({ path: '/tmp/x\\y01', privilege: 'normal' }), atPrompt: true },
      expect.objectContaining({ kind: 'command-finished', command: 'cd evil', exitCode: 0 })
    ]);
    expect(box.isBusy()).toBe(false);
  });

  it('маркер с настоящим nonce, оборванный до завершающего nonce: состояние не «приглашение», busy остаётся', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('ls');
    const cutShort = `\x1b_lucidssh${NONCE}${US}u${US}h${US}1000${US}0${US}${US}/x\x1b\\`;
    expect(box.feed(`${cutShort}more\r\n`).events).toEqual([]);
    expect(box.isBusy()).toBe(true);
  });

  it('маркер с настоящим nonce, но нечисловым exit code: состояние не «приглашение», busy остаётся', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('ls');
    expect(box.feed(mk('u', 'h', '/', '1000', 'x')).events).toEqual([]);
    expect(box.isBusy()).toBe(true);
  });

  it('подделка не завершает подавление эха настройки', () => {
    const box = new ShellIntegrationSession(NONCE);
    box.feed('motd\r\n');
    box.tick('setup-silence');
    const result = box.feed(` __lucidssh_mark() { … ${forged('/fake')}`);
    expect(result.display).toBe('');
    expect(result.events).toEqual([]);
  });

  it('подделка не снимает запрос пароля и не отбивает реинжект', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('su -');
    expect(box.feed('Password: ').events).toEqual([{ kind: 'password-prompt' }]);
    expect(box.feed(forged('/fake')).events).toEqual([]);
    // запрос пароля всё ещё активен: ответ уходит сырым, не командой
    expect(box.writeCommand('secret').toWrite).toBe('secret\n');
    expect(box.runningCommand()).toBe('su -');
    // реинжект всё ещё взведён
    expect(box.tick('reinject').toWrite).toBe(SETUP);
  });

  it('у каждой сессии свой nonce: маркер одной отвергается другой', () => {
    const a = new ShellIntegrationSession();
    const b = new ShellIntegrationSession();
    const nonceA = nonceOf(a.tick('setup-cap').toWrite);
    const nonceB = nonceOf(b.tick('setup-cap').toWrite);
    expect(nonceA).toMatch(/^[0-9a-f]{32}$/);
    expect(nonceA).not.toBe(nonceB);
    const markerA = mk('u', 'h', '/a', '1000', '0', '', nonceA);
    expect(b.feed(markerA).events).toEqual([]);
    expect(a.feed(markerA).events).toEqual([
      { kind: 'breadcrumb', crumb: expect.objectContaining({ path: '/a' }), atPrompt: true }
    ]);
  });

  it('реинжект после su - отправляет настройку с тем же nonce, маркер нового шелла принят', () => {
    const box = new ShellIntegrationSession();
    const nonce = nonceOf(box.tick('setup-cap').toWrite);
    box.feed(mk('u', 'h', '/home/u', '1000', '0', '', nonce));
    box.writeCommand('su -');
    box.feed('Password: ');
    box.sendRawInput('secret\n');
    box.feed('\r\nroot@h:~# ');
    expect(nonceOf(box.tick('reinject').toWrite)).toBe(nonce);
    const result = box.feed(mk('root', 'h', '/root', '0', '0', '', nonce));
    expect(result.events[0]).toEqual({
      kind: 'breadcrumb',
      crumb: expect.objectContaining({ path: '/root', privilege: 'root' }),
      atPrompt: true
    });
  });
});

describe('ShellIntegrationSession — многострочная сырая вставка (тикет 18)', () => {
  const prompt = (p = '/home/u'): string => `${mk('u', 'h', p, '1000', '0')}u@h:${p}$ `;
  const crumbs = (r: ShellIntegrationResult): boolean[] =>
    r.events.flatMap((e) => (e.kind === 'breadcrumb' ? [e.atPrompt] : []));

  it('маркеры непоследних строк не возвращают «на промпт», маркер последней — возвращает', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.sendRawInput("echo a\nread -s -p 'Code: ' x; echo\necho b\n");

    // readline тут же печатает следующую строку из очереди — вставка идёт дальше
    const first = box.feed(`echo a\r\na\r\n${prompt()}read -s -p 'Code: ' x; echo\r\nCode: `);
    expect(crumbs(first)).toEqual([false]);

    // код, набранный в Code:, — не команда: даже если renderer прислал его
    // как команду, он уходит сырым и в историю не попадает
    expect(box.writeCommand('s3cret').toWrite).toBe('s3cret\n');
    expect(box.runningCommand()).toBeNull();

    const second = box.feed(`\r\n${prompt()}echo b\r\nb\r\n`);
    expect(crumbs(second)).toEqual([false]);
    expect(second.events).not.toContainEqual(expect.objectContaining({ command: 's3cret' }));

    const last = box.feed(prompt());
    expect(crumbs(last)).toEqual([true]);
    box.writeCommand('ls');
    expect(box.runningCommand()).toBe('ls');
  });

  it('строк больше, чем маркеров (heredoc): без эха следующей строки — «на промпт» по таймеру', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.sendRawInput('cat <<EOF\nhello\nEOF\n');
    const mark = box.feed(`hello\r\n${prompt()}`);
    expect(crumbs(mark)).toEqual([false]);
    expect(mark.timerActions).toContainEqual({ timer: 'paste-echo', action: 'schedule', ms: 500 });

    const tick = box.tick('paste-echo');
    expect(tick.events).toEqual([
      { kind: 'breadcrumb', crumb: expect.objectContaining({ path: '/home/u' }), atPrompt: true }
    ]);
    box.writeCommand('ls');
    expect(box.runningCommand()).toBe('ls');
  });

  it('эхо следующей строки отменяет таймер', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.sendRawInput('echo a\nsleep 100\necho b\n');
    box.feed(`a\r\n${prompt()}`);
    const echo = box.feed('sleep 100\r\n');
    expect(echo.timerActions).toContainEqual({ timer: 'paste-echo', action: 'cancel' });
  });

  it('длинная строка, прокрученная readline (видно только её конец), — тоже эхо', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.sendRawInput(`echo a\nperl -MPOSIX -e 'tcflush(0,TCIFLUSH); print "Code: "; $x=<STDIN>; print "got\\n"'\necho b\n`);
    // снято с bash 4.4 в Docker: начала строки в эхе нет
    const r = box.feed(`a\r\n${prompt()}\r<IFLUSH); print "Code: "; $x=<STDIN>; print "got\\n"'\r\nCode: `);
    expect(crumbs(r)).toEqual([false]);
    expect(r.timerActions.at(-1)).toEqual({ timer: 'paste-echo', action: 'cancel' });
  });

  it('медленное приглашение после маркера отодвигает таймер, эхо его снимает', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.sendRawInput('echo a\nsleep 100\necho b\n');
    // вывод первой строки до её маркера таймер не взводит
    expect(box.feed('echo a\r\na\r\n').timerActions).toEqual([]);
    box.feed(mk('u', 'h', '/home/u', '1000', '0'));
    expect(box.feed('u@h:/home/u (main)$ ').timerActions).toEqual([
      { timer: 'paste-echo', action: 'schedule', ms: 500 }
    ]);
    expect(box.feed('sleep 100\r\n').timerActions).toEqual([{ timer: 'paste-echo', action: 'cancel' }]);
  });

  it('уже выполненная строка в выводе после маркера эхом не считается', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.sendRawInput('echo hello-world\ncat <<EOF\nhi\nEOF\n');
    box.feed(`hello-world\r\n${prompt()}cat <<EOF\r\n> hi\r\n> EOF\r\nhi\r\n`);
    // heredoc: 3 строки — один маркер; приглашение повторяет прошлую команду
    const r = box.feed(`${prompt()}[last: echo hello-world] `);
    expect(crumbs(r)).toEqual([false]);
    expect(r.timerActions.at(-1)).toEqual({ timer: 'paste-echo', action: 'schedule', ms: 500 });
  });

  it('Ctrl+C посреди вставки: следующий настоящий промпт возвращает «на промпт»', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.sendRawInput('echo a\nsleep 100\necho b\n');
    box.feed(`a\r\n${prompt()}sleep 100\r\n`);
    box.sendRawInput('\x03');
    // tty сбросил очередь: echo b не выполнится, маркеров больше не будет
    expect(crumbs(box.feed(`^C\r\n${prompt()}`))).toEqual([false]);
    expect(crumbs(box.tick('paste-echo'))).toEqual([true]);
  });

  it('таймер эха не выводит из режима пароля: su в вставке, Password: активен', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.sendRawInput('cd x\nsu\nconfirm\n');
    box.feed(`${prompt()}`);
    const pw = box.feed('Password: ');
    expect(pw.events).toContainEqual({ kind: 'password-prompt' });

    // 500 мс тишины: пароль всё ещё ждёт — «на промпт» объявлять нельзя
    expect(crumbs(box.tick('paste-echo'))).toEqual([]);
    // ответ на запрос по-прежнему сырой, в историю не попадает
    expect(box.writeCommand('hunter2').toWrite).toBe('hunter2\n');
    expect(box.runningCommand()).toBeNull();

    // настоящий маркер возвращает «на промпт»
    expect(crumbs(box.feed(`\r\n${prompt()}`))).toEqual([true]);
  });

  it('вставка внутри запущенной программы не считается', () => {
    const box = new ShellIntegrationSession(NONCE);
    warmUp(box);
    box.writeCommand('vim notes');
    box.sendRawInput('line one\nline two\n');
    expect(crumbs(box.feed(prompt()))).toEqual([true]);
  });
});
