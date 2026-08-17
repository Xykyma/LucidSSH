import { describe, expect, it } from 'vitest';
import {
  BreadcrumbParser,
  CommandGate,
  EchoGate,
  SHELL_INTEGRATION_SETUP,
  buildCdCommand,
  detectInteractiveProgram,
  endsWithInputPrompt,
  isShellEscalationCommand,
  matchesPasswordPromptPattern
} from './shellIntegration';

const US = '\x1f';
const mk = (u: string, h: string, p: string, e: string, c = '0', sudoUser = ''): string =>
  `\x1b_lucidssh${US}${u}${US}${h}${US}${p}${US}${e}${US}${c}${US}${sudoUser}\x1b\\`;

describe('BreadcrumbParser', () => {
  it('вырезает маркер и извлекает breadcrumb + exit code', () => {
    const parser = new BreadcrumbParser();
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
    const parser = new BreadcrumbParser();
    const { marks } = parser.push(mk('u', 'h', '/', '1000', '127'));
    expect(marks[0]?.exitCode).toBe(127);
  });

  it('обычный пользователь → privilege normal', () => {
    const parser = new BreadcrumbParser();
    const { marks } = parser.push(mk('ubuntu', 'srv', '/home/ubuntu', '1000'));
    expect(marks[0]?.crumb.privilege).toBe('normal');
  });

  it('euid=0 с SUDO_USER (sudo -i) → privilege sudo', () => {
    const parser = new BreadcrumbParser();
    const { marks } = parser.push(mk('root', 'srv', '/root', '0', '0', 'nikita'));
    expect(marks[0]?.crumb.privilege).toBe('sudo');
  });

  it('euid=0 без SUDO_USER (root-логин, su -) → privilege root', () => {
    const parser = new BreadcrumbParser();
    const { marks } = parser.push(mk('root', 'srv', '/root', '0', '0', ''));
    expect(marks[0]?.crumb.privilege).toBe('root');
  });

  it('SUDO_USER при euid≠0 (sudo -u www) → всё равно normal', () => {
    const parser = new BreadcrumbParser();
    const { marks } = parser.push(mk('www', 'srv', '/var/www', '33', '0', 'nikita'));
    expect(marks[0]?.crumb.privilege).toBe('normal');
  });

  it('маркер старого формата (5 полей, без SUDO_USER) разбирается как раньше', () => {
    const parser = new BreadcrumbParser();
    const legacy = `\x1b_lucidssh${US}root${US}h${US}/${US}0${US}0\x1b\\`;
    const { marks } = parser.push(legacy);
    expect(marks[0]?.crumb.privilege).toBe('root');
    expect(marks[0]?.exitCode).toBe(0);
  });

  it('собирает маркер, разрезанный между двумя чанками', () => {
    const parser = new BreadcrumbParser();
    const full = mk('root', 'h', '/etc', '0');
    const mid = Math.floor(full.length / 2);
    const r1 = parser.push('x' + full.slice(0, mid));
    expect(r1.marks).toHaveLength(0); // маркер ещё не завершён
    const r2 = parser.push(full.slice(mid) + 'y');
    expect(r2.marks).toHaveLength(1);
    expect(r1.cleaned + r2.cleaned).toBe('xy');
  });

  it('обычный вывод без маркеров проходит как есть', () => {
    const parser = new BreadcrumbParser();
    const { cleaned, marks } = parser.push('total 42\r\ndrwxr-xr-x 2 root root\r\n');
    expect(cleaned).toBe('total 42\r\ndrwxr-xr-x 2 root root\r\n');
    expect(marks).toHaveLength(0);
  });

  it('несколько маркеров в одном чанке', () => {
    const parser = new BreadcrumbParser();
    const { cleaned, marks } = parser.push(mk('a', 'h', '/', '0') + 'mid' + mk('a', 'h', '/tmp', '1000'));
    expect(cleaned).toBe('mid');
    expect(marks).toHaveLength(2);
    expect(marks[1]?.crumb.path).toBe('/tmp');
  });

  it('pieces: текст разбит по позициям маркеров, длина = marks + 1', () => {
    const parser = new BreadcrumbParser();
    const { pieces, marks } = parser.push('echo' + mk('u', 'h', '/', '1000') + 'prompt$ ');
    expect(marks).toHaveLength(1);
    expect(pieces).toEqual(['echo', 'prompt$ ']);
  });

  it('pieces: чанк без маркеров — один кусок', () => {
    const parser = new BreadcrumbParser();
    const { pieces } = parser.push('plain output');
    expect(pieces).toEqual(['plain output']);
  });

  it('pieces: маркер, разрезанный между чанками, не создаёт ложных границ', () => {
    const parser = new BreadcrumbParser();
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

describe('SHELL_INTEGRATION_SETUP', () => {
  it('каждая строка короче лимита редактора строки BusyBox', () => {
    // CONFIG_FEATURE_EDITING_MAX_LEN на роутерах обычно 512: слитная строка
    // длиннее обрезается ash молча, ломая кавычки (Keenetic/Xkeen 10.07.2026).
    // Запас до 500 — на будущие правки.
    expect(SHELL_INTEGRATION_SETUP.endsWith('\n')).toBe(true);
    const lines = SHELL_INTEGRATION_SETUP.slice(0, -1).split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line.length).toBeLessThan(500);
      // каждая строка — законченная команда, начинается пробелом (HISTCONTROL)
      expect(line.startsWith(' ')).toBe(true);
    }
    // финальный вызов-сигнал «настройка выполнена» — в самом конце
    expect(lines[lines.length - 1]!.endsWith('__lucidssh_mark')).toBe(true);
  });

  it('без сырых управляющих байт: US/ESC только октавами внутри printf', () => {
    expect(SHELL_INTEGRATION_SETUP).not.toContain('\x1f');
    expect(SHELL_INTEGRATION_SETUP).not.toContain('\x1b');
  });

  it('три ветки: zsh precmd, bash PROMPT_COMMAND, POSIX-fallback через PS1', () => {
    expect(SHELL_INTEGRATION_SETUP).toContain('ZSH_VERSION');
    expect(SHELL_INTEGRATION_SETUP).toContain('add-zsh-hook precmd');
    expect(SHELL_INTEGRATION_SETUP).toContain('BASH_VERSION');
    // bash — только PROMPT_COMMAND: маркер в PS1 перепечатывается readline
    // при SIGWINCH/Ctrl+L со старым $? (баг самопереоткрытия детектора)
    expect(SHELL_INTEGRATION_SETUP).toContain('PROMPT_COMMAND="__lucidssh_mark');
    expect(SHELL_INTEGRATION_SETUP).toContain(`PS1='$(__lucidssh_mark)'"$PS1"`);
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

describe('buildCdCommand', () => {
  it('оборачивает путь в кавычки', () => {
    expect(buildCdCommand('/var/www')).toBe("cd '/var/www'");
  });

  it('экранирует одинарные кавычки в пути (защита от инъекции, §19)', () => {
    expect(buildCdCommand("/tmp/a'b")).toBe("cd '/tmp/a'\\''b'");
  });
});
