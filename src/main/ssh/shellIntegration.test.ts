import { describe, expect, it } from 'vitest';
import {
  BreadcrumbParser,
  CommandGate,
  EchoGate,
  detectInteractiveProgram,
  endsWithInputPrompt,
  isShellEscalationCommand,
  matchesPasswordPromptPattern,
  shellIntegrationSetup,
  stripTerminalControls
} from './shellIntegration';

const US = '\x1f';
const NONCE = '0123456789abcdef0123456789abcdef';
const SETUP = shellIntegrationSetup(NONCE);
const mk = (u: string, h: string, p: string, e: string, c = '0', sudoUser = '', nonce = NONCE): string =>
  `\x1b_lucidssh${nonce}${US}${u}${US}${h}${US}${e}${US}${c}${US}${sudoUser}${US}${p}${US}${nonce}\x1b\\`;

describe('BreadcrumbParser', () => {
  it('вырезает маркер и извлекает breadcrumb + exit code', () => {
    const parser = new BreadcrumbParser(NONCE);
    const { cleaned, marks } = parser.push(`before${mk('root', 'web-01', '/var/www', '0', '0')}after`);
    expect(cleaned).toBe('beforeafter'); // маркер не попал в вывод
    expect(marks).toHaveLength(1);
    expect(marks[0]?.crumb).toMatchObject({
      username: 'root',
      host: 'web-01',
      path: '/var/www',
      privilege: 'root' // euid 0
    });
    expect(marks[0]?.exitCode).toBe(0);
  });

  it('несёт ненулевой exit code', () => {
    const parser = new BreadcrumbParser(NONCE);
    const { marks } = parser.push(mk('u', 'h', '/', '1000', '127'));
    expect(marks[0]?.exitCode).toBe(127);
  });

  it('обычный пользователь → privilege normal', () => {
    const parser = new BreadcrumbParser(NONCE);
    const { marks } = parser.push(mk('ubuntu', 'srv', '/home/ubuntu', '1000'));
    expect(marks[0]?.crumb.privilege).toBe('normal');
  });

  it('euid=0 с SUDO_USER (sudo -i) → privilege sudo', () => {
    const parser = new BreadcrumbParser(NONCE);
    const { marks } = parser.push(mk('root', 'srv', '/root', '0', '0', 'nikita'));
    expect(marks[0]?.crumb.privilege).toBe('sudo');
  });

  it('euid=0 без SUDO_USER (root-логин, su -) → privilege root', () => {
    const parser = new BreadcrumbParser(NONCE);
    const { marks } = parser.push(mk('root', 'srv', '/root', '0', '0', ''));
    expect(marks[0]?.crumb.privilege).toBe('root');
  });

  it('SUDO_USER при euid≠0 (sudo -u www) → всё равно normal', () => {
    const parser = new BreadcrumbParser(NONCE);
    const { marks } = parser.push(mk('www', 'srv', '/var/www', '33', '0', 'nikita'));
    expect(marks[0]?.crumb.privilege).toBe('normal');
  });

  it('маркер без nonce сессии или с чужим — вырезан из вывода, но не считается маркером', () => {
    const parser = new BreadcrumbParser(NONCE);
    const noNonce = `\x1b_lucidssh${US}root${US}h${US}/fake${US}0${US}0${US}\x1b\\`;
    const wrong = mk('root', 'h', '/fake', '0', '0', '', 'ffffffffffffffffffffffffffffffff');
    const { cleaned, pieces, marks } = parser.push(`a${noNonce}b${wrong}c`);
    expect(cleaned).toBe('abc');
    expect(pieces).toEqual(['abc']);
    expect(marks).toHaveLength(0);
  });

  it('маркер старого 5-полевого формата не принимается даже с верным nonce', () => {
    const parser = new BreadcrumbParser(NONCE);
    const legacy = `\x1b_lucidssh${NONCE}${US}root${US}h${US}/${US}0${US}0\x1b\\`;
    expect(parser.push(legacy).marks).toHaveLength(0);
  });

  it('маркер формата тикета 14 (путь в середине, без завершающего nonce) не принимается', () => {
    const parser = new BreadcrumbParser(NONCE);
    const v14 = `\x1b_lucidssh${NONCE}${US}root${US}h${US}/${US}0${US}0${US}\x1b\\`;
    expect(parser.push(v14).marks).toHaveLength(0);
  });

  it('US в имени каталога не сдвигает euid и exit code (тикет 17)', () => {
    const parser = new BreadcrumbParser(NONCE);
    // каталог «a␟0␟1␟b»: в прежней раскладке сдвинул бы поля в euid=0 (root)
    const { cleaned, marks } = parser.push(mk('u', 'h', `/srv/a${US}0${US}1${US}b`, '1000', '0'));
    expect(cleaned).toBe('');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.crumb).toMatchObject({ username: 'u', host: 'h', path: '/srv/a01b', privilege: 'normal' });
    expect(marks[0]?.exitCode).toBe(0);
  });

  it('ESC \\ в имени каталога не обрывает маркер: поля верные, nonce не попадает в вывод (тикет 17)', () => {
    const parser = new BreadcrumbParser(NONCE);
    const { cleaned, marks } = parser.push(`a${mk('u', 'h', `/srv/x\x1b\\${US}0${US}1y`, '1000', '0')}b`);
    expect(cleaned).toBe('ab');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.crumb).toMatchObject({ path: '/srv/x\\01y', privilege: 'normal' });
    expect(marks[0]?.exitCode).toBe(0);
  });

  it('то же, разрезанное между чанками прямо по ESC \\ из имени каталога', () => {
    const parser = new BreadcrumbParser(NONCE);
    const full = mk('u', 'h', '/srv/x\x1b\\y', '1000', '2');
    const cut = full.indexOf('\x1b\\') + 2;
    const r1 = parser.push(full.slice(0, cut));
    expect(r1.marks).toHaveLength(0);
    expect(r1.cleaned).toBe('');
    const r2 = parser.push(full.slice(cut));
    expect(r2.cleaned).toBe('');
    expect(r2.marks[0]?.exitCode).toBe(2);
  });

  it('висящее начало подделки перед настоящим маркером не проглатывает его', () => {
    const parser = new BreadcrumbParser(NONCE);
    // `cat` файла, оборванного на `ESC _lucidssh…`; путь настоящего маркера с ESC \
    const { cleaned, marks } = parser.push(`out\x1b_lucidssh${US}x${mk('u', 'h', '/a\x1b\\b', '1000', '3')}$ `);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.exitCode).toBe(3);
    expect(cleaned).toBe(`out${US}x$ `); // хвост подделки — обычный вывод
  });

  it('оборванный настоящий маркер не склеивается со следующим', () => {
    const parser = new BreadcrumbParser(NONCE);
    const cutShort = `\x1b_lucidssh${NONCE}${US}u${US}h${US}1000${US}130${US}`;
    const r1 = parser.push(`${cutShort}^C\r\n`);
    expect(r1.marks).toHaveLength(0);
    const r2 = parser.push(`${mk('u', 'h', '/srv', '1000', '130')}$ `);
    expect(r2.marks).toHaveLength(1);
    expect(r2.marks[0]?.crumb.path).toBe('/srv');
    expect(r1.cleaned + r2.cleaned).not.toContain(NONCE);
  });

  it('маркер с длинным путём (PATH_MAX), пришедший несколькими чанками, не вываливается на экран', () => {
    const parser = new BreadcrumbParser(NONCE);
    const full = mk('u', 'h', '/' + 'd'.repeat(4094), '1000', '0');
    let cleaned = '';
    let marks = 0;
    for (let i = 0; i < full.length; i += 1000) {
      const r = parser.push(full.slice(i, i + 1000));
      cleaned += r.cleaned;
      marks += r.marks.length;
    }
    expect(cleaned).toBe('');
    expect(marks).toBe(1);
  });

  it('маркер без завершающего nonce (оборван) не принимается', () => {
    const parser = new BreadcrumbParser(NONCE);
    const cutShort = `\x1b_lucidssh${NONCE}${US}u${US}h${US}1000${US}0${US}${US}/x\x1b\\`;
    // ждёт настоящего конца — до лимита хвоста, маркера нет
    expect(parser.push(cutShort).marks).toHaveLength(0);
    expect(parser.push('x'.repeat(5000)).marks).toHaveLength(0);
  });

  it('нечисловые euid / exit code и нехватка полей — маркер не принимается', () => {
    const parser = new BreadcrumbParser(NONCE);
    expect(parser.push(mk('u', 'h', '/', '', '0')).marks).toHaveLength(0);
    expect(parser.push(mk('u', 'h', '/', '0x0', '0')).marks).toHaveLength(0);
    expect(parser.push(mk('u', 'h', '/', '1000', '-1')).marks).toHaveLength(0);
    expect(parser.push(mk('u', 'h', '/', '1000', '1 ')).marks).toHaveLength(0);
    const short = `\x1b_lucidssh${NONCE}${US}u${US}1000${US}0${US}${US}/${US}${NONCE}\x1b\\`;
    expect(parser.push(short).marks).toHaveLength(0);
  });

  it('собирает маркер, разрезанный между двумя чанками', () => {
    const parser = new BreadcrumbParser(NONCE);
    const full = mk('root', 'h', '/etc', '0');
    const mid = Math.floor(full.length / 2);
    const r1 = parser.push('x' + full.slice(0, mid));
    expect(r1.marks).toHaveLength(0); // маркер ещё не завершён
    const r2 = parser.push(full.slice(mid) + 'y');
    expect(r2.marks).toHaveLength(1);
    expect(r1.cleaned + r2.cleaned).toBe('xy');
  });

  it('обычный вывод без маркеров проходит как есть', () => {
    const parser = new BreadcrumbParser(NONCE);
    const { cleaned, marks } = parser.push('total 42\r\ndrwxr-xr-x 2 root root\r\n');
    expect(cleaned).toBe('total 42\r\ndrwxr-xr-x 2 root root\r\n');
    expect(marks).toHaveLength(0);
  });

  it('несколько маркеров в одном чанке', () => {
    const parser = new BreadcrumbParser(NONCE);
    const { cleaned, marks } = parser.push(mk('a', 'h', '/', '0') + 'mid' + mk('a', 'h', '/tmp', '1000'));
    expect(cleaned).toBe('mid');
    expect(marks).toHaveLength(2);
    expect(marks[1]?.crumb.path).toBe('/tmp');
  });

  it('pieces: текст разбит по позициям маркеров, длина = marks + 1', () => {
    const parser = new BreadcrumbParser(NONCE);
    const { pieces, marks } = parser.push('echo' + mk('u', 'h', '/', '1000') + 'prompt$ ');
    expect(marks).toHaveLength(1);
    expect(pieces).toEqual(['echo', 'prompt$ ']);
  });

  it('pieces: чанк без маркеров — один кусок', () => {
    const parser = new BreadcrumbParser(NONCE);
    const { pieces } = parser.push('plain output');
    expect(pieces).toEqual(['plain output']);
  });

  it('pieces: маркер, разрезанный между чанками, не создаёт ложных границ', () => {
    const parser = new BreadcrumbParser(NONCE);
    const full = mk('u', 'h', '/', '1000');
    const mid = Math.floor(full.length / 2);
    const r1 = parser.push('a' + full.slice(0, mid));
    expect(r1.pieces).toEqual(['a']); // незавершённый маркер придержан
    const r2 = parser.push(full.slice(mid) + 'b');
    expect(r2.marks).toHaveLength(1);
    expect(r2.pieces).toEqual(['', 'b']);
  });
});

describe('EchoGate — подавление эха setup-команды (MOTD без прокрутки)', () => {
  it('неактивный гейт пропускает всё как есть', () => {
    const gate = new EchoGate();
    expect(gate.filter(['motd line\r\n'], 0)).toEqual(['motd line\r\n']);
    expect(gate.active).toBe(false);
  });

  it('после arm() копит текст до маркера и не пересылает его', () => {
    const gate = new EchoGate();
    gate.arm();
    expect(gate.filter([' __lucidssh_mark() { …эхо…'], 0)).toEqual(['']);
    expect(gate.filter(['…хвост эха…\r\n'], 0)).toEqual(['']);
    expect(gate.active).toBe(true);
  });

  it('первый маркер: эхо отброшено, строка стёрта (\\r ESC[K), хвост чанка пересылается', () => {
    const gate = new EchoGate();
    gate.arm();
    gate.filter(['…эхо…'], 0);
    // чанк, где пришёл маркер: до маркера — остаток эха, после — новое приглашение
    const out = gate.filter(['конец эха', 'user@host:~$ '], 1);
    expect(out.join('')).toBe('\r\x1b[Kuser@host:~$ ');
    expect(out).toEqual(['\r\x1b[K', 'user@host:~$ ']);
    expect(gate.active).toBe(false);
  });

  it('после закрытия гейт снова прозрачен, повторные маркеры не влияют', () => {
    const gate = new EchoGate();
    gate.arm();
    gate.filter(['x', 'y'], 1);
    expect(gate.filter(['ls output', 'prompt$ '], 1)).toEqual(['ls output', 'prompt$ ']);
  });

  it('flush по таймауту возвращает накопленное и выключает подавление', () => {
    const gate = new EchoGate();
    gate.arm();
    gate.filter(['вывод shell без маркеров'], 0);
    expect(gate.flush()).toBe('вывод shell без маркеров');
    expect(gate.active).toBe(false);
    expect(gate.filter(['дальше как обычно'], 0)).toEqual(['дальше как обычно']);
  });

  it('два маркера в одном чанке (явный вызов + PROMPT_COMMAND): пересылается всё после первого', () => {
    const gate = new EchoGate();
    gate.arm();
    const out = gate.filter(['эхо', '', 'prompt$ '], 2);
    expect(out.join('')).toBe('\r\x1b[Kprompt$ ');
    // каждый маркер получает свой кусок для правильной атрибуции вывода
    expect(out).toEqual(['\r\x1b[K', '', 'prompt$ ']);
  });

  it('несколько маркеров в одном чанке вне подавления — каждому свой кусок (не единая строка)', () => {
    const gate = new EchoGate();
    // typo1\r\n...command not found\r\n | typo2\r\n...command not found\r\n | prompt
    const out = gate.filter(['typo1: command not found\r\n', 'typo2: command not found\r\n', 'prompt$ '], 2);
    expect(out).toEqual([
      'typo1: command not found\r\n',
      'typo2: command not found\r\n',
      'prompt$ '
    ]);
  });
});

describe('shellIntegrationSetup', () => {
  it('nonce сессии — литералом в формате printf, сразу после префикса маркера', () => {
    expect(SETUP).toContain(`'\\033_lucidssh${NONCE}\\037%s`);
  });

  it('каждая строка короче лимита редактора строки BusyBox', () => {
    // CONFIG_FEATURE_EDITING_MAX_LEN на роутерах обычно 512: слитная строка
    // длиннее обрезается ash молча, ломая кавычки (Keenetic/Xkeen 10.07.2026).
    // Запас до 500 — на будущие правки.
    expect(SETUP.endsWith('\n')).toBe(true);
    const lines = SETUP.slice(0, -1).split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line.length).toBeLessThan(500);
      // каждая строка — законченная команда, начинается пробелом (HISTCONTROL)
      expect(line.startsWith(' ')).toBe(true);
    }
    // финальный вызов-сигнал «настройка выполнена» — в самом конце
    expect(lines[lines.length - 1]!.endsWith('__lucidssh_mark;; esac')).toBe(true);
  });

  it('без встроенного printf ничего не включается: каждая строка целиком под проверкой builtin (тикет 17)', () => {
    // LC_ALL=C: bash переводит «is a shell builtin» — на ru_RU иначе не совпало бы
    const guard = ' case $(LC_ALL=C;command -V printf 2>&1) in *builtin) ';
    const lines = SETUP.slice(0, -1).split('\n');
    for (const line of lines) {
      // проверка — первое, что делает строка; всё остальное — в её ветке *builtin)
      expect(line.startsWith(guard)).toBe(true);
      expect(line.endsWith(';; esac')).toBe(true);
    }
    // проверка идёт раньше определения функции и любого хука
    expect(SETUP.indexOf('command -V printf')).toBeLessThan(SETUP.indexOf('__lucidssh_mark()'));
  });

  it('nonce — только в формате встроенного printf (в начале и в конце маркера), не в argv', () => {
    const fmt = `printf '\\033_lucidssh${NONCE}\\037%s\\037%s\\037%s\\037%s\\037%s\\037%s\\037${NONCE}\\033\\\\' `;
    expect(SETUP).toContain(fmt);
    expect(SETUP.split(NONCE)).toHaveLength(3); // ровно два вхождения — оба в fmt
    // $PWD — последний аргумент
    expect(SETUP).toContain('"${SUDO_USER:-}" "$PWD"; }');
  });

  it('без сырых управляющих байт: US/ESC только октавами внутри printf', () => {
    expect(SETUP).not.toContain('\x1f');
    expect(SETUP).not.toContain('\x1b');
  });

  it('три ветки: zsh precmd, bash PROMPT_COMMAND, POSIX-fallback через PS1', () => {
    expect(SETUP).toContain('ZSH_VERSION');
    expect(SETUP).toContain('add-zsh-hook precmd');
    expect(SETUP).toContain('BASH_VERSION');
    // bash — только PROMPT_COMMAND: маркер в PS1 перепечатывается readline
    // при SIGWINCH/Ctrl+L со старым $? (баг самопереоткрытия детектора)
    expect(SETUP).toContain('PROMPT_COMMAND="__lucidssh_mark');
    expect(SETUP).toContain(`PS1='$(__lucidssh_mark)'"$PS1"`);
  });
});

describe('CommandGate — маркер без Enter = перерисовка приглашения, не команда', () => {
  it('маркер после команды с Enter — ran и typed', () => {
    const gate = new CommandGate();
    gate.noteInput('норлл\n');
    expect(gate.consume()).toEqual({ ran: true, typed: true });
  });

  it('маркер без ввода (SIGWINCH при открытии/закрытии панели) — ran=false', () => {
    const gate = new CommandGate();
    gate.noteInput('норлл\n');
    gate.consume(); // настоящий маркер команды
    // resize → readline перепечатал промпт с APC-маркером — ввода не было
    expect(gate.consume()).toEqual({ ran: false, typed: false });
    expect(gate.consume()).toEqual({ ran: false, typed: false }); // и по кругу
  });

  it('пустой Enter — ran=true, но typed=false (нечего объяснять, $? старый)', () => {
    const gate = new CommandGate();
    gate.noteInput('\r');
    expect(gate.consume()).toEqual({ ran: true, typed: false });
  });

  it('посимвольный прямой ввод в xterm: буквы, затем Enter', () => {
    const gate = new CommandGate();
    for (const ch of ['l', 's', '\r']) gate.noteInput(ch);
    expect(gate.consume()).toEqual({ ran: true, typed: true });
    expect(gate.consume().ran).toBe(false); // следующий маркер — уже перерисовка
  });

  it('многострочная вставка: кредит на каждую строку, typed сохраняется', () => {
    const gate = new CommandGate();
    gate.noteInput('cmd1\ncmd2\n');
    expect(gate.consume()).toEqual({ ran: true, typed: true });
    expect(gate.consume()).toEqual({ ran: true, typed: true });
    expect(gate.consume().ran).toBe(false);
  });

  it('\\r\\n считается одним Enter', () => {
    const gate = new CommandGate();
    gate.noteInput('ls\r\n');
    expect(gate.consume().ran).toBe(true);
    expect(gate.consume().ran).toBe(false);
  });

  it('reset() при новом shell обнуляет кредиты', () => {
    const gate = new CommandGate();
    gate.noteInput('ls\n');
    gate.reset();
    expect(gate.consume().ran).toBe(false);
  });

  it('кредиты капятся — Enter\'ы внутри интерактивной программы не копятся вечно', () => {
    const gate = new CommandGate();
    gate.noteInput('\n'.repeat(100));
    let ran = 0;
    while (gate.consume().ran) ran++;
    expect(ran).toBeLessThanOrEqual(20);
  });
});

describe('isShellEscalationCommand — команды, сменяющие процесс shell (фикс BRD-03/04)', () => {
  it.each([
    'sudo -i',
    'sudo -s',
    'sudo su',
    'sudo su -',
    'sudo su - postgres',
    'su',
    'su -',
    'su - deploy',
    'sudo bash',
    'sudo -u deploy -i',
    'sudo -iu deploy',
    'bash',
    'zsh -l',
    '/bin/bash',
    'exec su -',
    'doas -s',
    'cd /tmp && sudo -i',
    'cd /tmp\nsudo -i', // перевод строки — тоже разделитель (splitCompound)
    'long_task & sudo -i' // guard-background-ampersand: & тоже разделитель
  ])('эскалация: %s', (cmd) => {
    expect(isShellEscalationCommand(cmd)).toBe(true);
  });

  it.each([
    'sudo apt update',
    'sudo systemctl restart nginx',
    'sudo -u www id',
    'bash deploy.sh',
    'sh -c "ls"',
    'ssh host',
    'ls -la',
    'suspend',
    'echo su',
    'cat /etc/sudoers',
    'echo hi 2>&1' // guard-background-ampersand: редирект — не разделитель, не эскалация
  ])('не эскалация: %s', (cmd) => {
    expect(isShellEscalationCommand(cmd)).toBe(false);
  });
});

describe('detectInteractiveProgram (BRD-05) — запуск известной интерактивной программы', () => {
  it.each([
    ['nano', 'nano'],
    ['nano file.txt', 'nano'],
    ['vim /etc/hosts', 'vim'],
    ['less /var/log/syslog', 'less'],
    ['man ls', 'man'],
    ['htop', 'htop'],
    ['top', 'top'],
    ['sudo nano /etc/hosts', 'nano'],
    ['sudo htop', 'htop'],
    ['cd /var && less log', 'less'],
    ['cd /var; htop', 'htop'],
    ['/usr/bin/vim file', 'vim'],
    ['long_task & htop', 'htop'] // guard-background-ampersand: & тоже разделитель
  ] as const)('%s → %s', (cmd, expected) => {
    expect(detectInteractiveProgram(cmd)).toBe(expected);
  });

  it.each([
    'ls -la',
    'cat man.txt',
    'echo top',
    'topless', // не должно матчиться как отдельное слово 'top'
    'nginx',
    'sudo apt update',
    'echo hi 2>&1' // guard-background-ampersand: редирект — не разделитель
  ])('не интерактивная программа: %s', (cmd) => {
    expect(detectInteractiveProgram(cmd)).toBeNull();
  });
});

describe('endsWithInputPrompt — придержать реинжект на запросе пароля', () => {
  it.each([
    '[sudo] password for nikita:',
    '[sudo] password for nikita: ',
    'Password:',
    'Пароль:',
    "Enter passphrase for key '/root/.ssh/id_ed25519':"
  ])('запрос ввода: %j', (tail) => {
    expect(endsWithInputPrompt(tail)).toBe(true);
  });

  it.each([
    'root@football-bot:~# ',
    'user@host:~$ ',
    'srv % ',
    'total 42\r\n',
    // двоеточие есть, но строка завершена переводом строки — ввод не ждут
    'Warning: something happened:\n'
  ])('не запрос ввода: %j', (tail) => {
    expect(endsWithInputPrompt(tail)).toBe(false);
  });
});

describe('matchesPasswordPromptPattern (TERM-09) — только явный статичный список, без «:»-эвристики', () => {
  it.each([
    '[sudo] password for nikita:',
    '[sudo] password for nikita: ',
    'Password:',
    'Пароль:',
    "Enter passphrase for key '/root/.ssh/id_ed25519':"
  ])('распознаёт: %j', (tail) => {
    expect(matchesPasswordPromptPattern(tail)).toBe(true);
  });

  it.each([
    'root@football-bot:~# ',
    'user@host:~$ ',
    // произвольная строка на «:» — НЕ распознаётся (в отличие от endsWithInputPrompt)
    'Warning: something happened:',
    'Available options:',
    'total 42\r\n'
  ])('не распознаёт: %j', (tail) => {
    expect(matchesPasswordPromptPattern(tail)).toBe(false);
  });
});

describe('BreadcrumbParser — управляющие последовательности экрана проходят насквозь', () => {
  // Баг «после выхода из top не возвращается экран» (21.08.2026) сначала искали
  // здесь: подозревали, что придерживание хвоста (см. push) рвёт ESC[?1049l.
  // Живая проверка через Docker показала, что конвейер чист, а top вообще не
  // шлёт smcup/rmcup — чинилось на стороне xterm.js (scrollOnEraseInDisplay,
  // XtermView.tsx). Тесты закрепляют «конвейер не при чём», чтобы при
  // следующем похожем симптоме сюда не возвращались.
  const ALT_ON = '[?1049h[22;0;0t';
  const ALT_OFF = '[?1049l[23;0;0t';

  it('smcup/rmcup доходят до терминала без изменений', () => {
    const parser = new BreadcrumbParser(NONCE);
    const { cleaned } = parser.push(`${ALT_ON}vim screen${ALT_OFF}`);
    expect(cleaned).toBe(`${ALT_ON}vim screen${ALT_OFF}`);
  });

  it('ESC на границе чанков не теряется (rmcup разрезан пополам)', () => {
    const parser = new BreadcrumbParser(NONCE);
    // Хвост, начинающийся с ESC, придерживается до следующего чанка — важно,
    // чтобы он вернулся целиком, а не был проглочен как недописанный маркер.
    const first = parser.push('bye');
    expect(first.cleaned).toBe('bye');
    const second = parser.push('[?1049l');
    expect(second.cleaned).toBe('[?1049l');
  });

  it('очистка экрана (ED2, так делает top) не вырезается вместе с маркером', () => {
    const parser = new BreadcrumbParser(NONCE);
    const { cleaned, marks } = parser.push(`[H[2Jtop frame${mk('u', 'h', '/root', '0', '0')}`);
    expect(cleaned).toBe('[H[2Jtop frame');
    expect(marks).toHaveLength(1);
  });

  it('поддельный маркер: управляющие символы из полей вырезаются', () => {
    const parser = new BreadcrumbParser(NONCE);
    const forged = mk('ro\x1b[31mot', 'h\x07ost', '/srv/a\nid\r\x1b[2K\x7f\u009b1mb\tc', '1000');
    const { marks } = parser.push(forged);
    expect(marks[0]?.crumb).toMatchObject({
      username: 'ro[31mot',
      host: 'host',
      path: '/srv/aid[2K1mbc'
    });
  });
});

describe('stripTerminalControls (HIST-09)', () => {
  it('OSC с BEL и с ESC-backslash, SGR, ESC[K, одиночный ESC в конце', () => {
    expect(stripTerminalControls('\x1b]0;t\x07a\x1b]0;t\x1b\\b')).toBe('ab');
    expect(stripTerminalControls('\x1b[1;31mred\x1b[0m\x1b[K!')).toBe('red!');
    expect(stripTerminalControls('x\x1b')).toBe('x');
  });
  it('CRLF и TAB не трогает', () => {
    expect(stripTerminalControls('a\r\n\tb\n')).toBe('a\r\n\tb\n');
  });
  it('незавершённый OSC с длинным хвостом — за линейное время', () => {
    const t = Date.now();
    const a = stripTerminalControls('\x1b]0;' + 'a'.repeat(200000));
    const b = stripTerminalControls('\x1b]'.repeat(100000));
    expect(Date.now() - t).toBeLessThan(2000);
    expect(a.startsWith(']0;a')).toBe(true);
    expect(b).toBe(']'.repeat(100000));
  });
  it('оборванные последовательности не оставляют ESC-байт', () => {
    expect(stripTerminalControls('a\x1b]0;aaa')).not.toContain('\x1b');
    expect(stripTerminalControls('a\x1b[1;3')).not.toContain('\x1b');
    expect(stripTerminalControls('a\x1b[')).toBe('a[');
  });
});
