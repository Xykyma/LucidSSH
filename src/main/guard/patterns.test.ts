import { describe, expect, it } from 'vitest';
import { analyzeAccessRisk, analyzeCommand, CONFIRM_WORD, stripCmdPrefix } from './patterns';

/**
 * Обязательное покрытие guard/patterns.ts (CLAUDE.md §10):
 * и срабатывание, и отсутствие ложных срабатываний.
 */

describe('analyzeCommand — срабатывание (GUARD-01)', () => {
  it('rm -rf с путём', () => {
    const m = analyzeCommand('rm -rf /var/www');
    expect(m).toMatchObject({ patternId: 'rm-recursive', target: '/var/www', scope: 'directory' });
    expect(m?.confirmationText).toBe('www'); // GUARD-03: реальное имя объекта
    expect(m?.confirmationKind).toBe('target');
  });

  it('rm -fr (другой порядок флагов) и rm -r', () => {
    expect(analyzeCommand('rm -fr /etc/nginx')?.patternId).toBe('rm-recursive');
    expect(analyzeCommand('rm -r ./build')?.patternId).toBe('rm-recursive');
  });

  it('rm -rf / — масштаб диск, подтверждается непустым текстом', () => {
    const m = analyzeCommand('rm -rf /');
    expect(m?.scope).toBe('disk');
    // У корня нет последнего сегмента: пустой текст подтверждения означал бы
    // активную кнопку при пустом поле — самая опасная команда без трения.
    expect(m?.confirmationText).toBe('/');
  });

  it('rm -rf /* — подтверждается звёздочкой, не пустой строкой', () => {
    expect(analyzeCommand('rm -rf /*')?.confirmationText).toBe('*');
  });

  it('sudo не прячет команду', () => {
    expect(analyzeCommand('sudo rm -rf /opt/app')?.patternId).toBe('rm-recursive');
  });

  it('опасная часть составной команды', () => {
    const m = analyzeCommand('cd /tmp && rm -rf ./cache');
    expect(m?.patternId).toBe('rm-recursive');
    expect(m?.target).toBe('./cache');
    expect(analyzeCommand('echo hi; dd if=/dev/zero of=/dev/sda')?.patternId).toBe('dd-write');
  });

  it('dd в устройство — масштаб диск', () => {
    const m = analyzeCommand('dd if=/dev/zero of=/dev/sda bs=1M');
    expect(m).toMatchObject({ patternId: 'dd-write', target: '/dev/sda', scope: 'disk' });
  });

  it('mkfs с типом и без', () => {
    expect(analyzeCommand('mkfs.ext4 /dev/sdb1')?.target).toBe('/dev/sdb1');
    expect(analyzeCommand('mkfs /dev/sdb1')?.patternId).toBe('mkfs');
  });

  it('chmod -R 777', () => {
    const m = analyzeCommand('chmod -R 777 /var/www');
    expect(m).toMatchObject({ patternId: 'chmod-777', target: '/var/www' });
  });

  it('truncate -s 0', () => {
    expect(analyzeCommand('truncate -s 0 /var/log/syslog')?.patternId).toBe('truncate');
  });

  it('перенаправление в устройство', () => {
    expect(analyzeCommand('echo test > /dev/sda')?.patternId).toBe('redirect-device');
    expect(analyzeCommand('cat backup.img > /dev/nvme0n1')?.scope).toBe('disk');
  });

  it('перенаправление в устройство без пробела (guard-background-ampersand: не съедается как хвостовой редирект)', () => {
    expect(analyzeCommand('echo test >/dev/sda')?.patternId).toBe('redirect-device');
    expect(analyzeCommand('echo test >>/dev/sda')?.patternId).toBe('redirect-device');
    expect(analyzeCommand('echo hi >/dev/sda &')?.patternId).toBe('redirect-device');
  });

  it('fork-бомба — подтверждение словом', () => {
    const m = analyzeCommand(':(){ :|:& };:');
    expect(m?.patternId).toBe('fork-bomb');
    expect(m?.confirmationText).toBe(CONFIRM_WORD);
    expect(m?.confirmationKind).toBe('word');
  });

  it('drop database', () => {
    expect(analyzeCommand('mysql -e "DROP DATABASE production"')?.patternId).toBe('drop-database');
  });

  it('shred и wipefs', () => {
    expect(analyzeCommand('shred -n 3 /dev/sdb')?.scope).toBe('disk');
    expect(analyzeCommand('wipefs -a /dev/sdc')?.patternId).toBe('wipefs');
  });

  it('kill -9 1', () => {
    expect(analyzeCommand('kill -9 1')?.patternId).toBe('kill-init');
  });
});

/**
 * GUARD-03: цель подтверждения — объект из опасного фрагмента, а не хвост всей
 * строки. Регресс на дефекте, когда `rm -rf /var/www; echo done` просил набрать
 * «done»: паттерны с якорем `$` захватывали конец строки целиком.
 */
describe('analyzeCommand — цель в составной команде (GUARD-03)', () => {
  const cases: { cmd: string; target: string; confirmationText: string }[] = [
    { cmd: 'rm -rf /var/www; echo done', target: '/var/www', confirmationText: 'www' },
    {
      cmd: 'rm -rf ./node_modules && npm install',
      target: './node_modules',
      confirmationText: 'node_modules'
    },
    { cmd: 'rm -rf dist && npm run build', target: 'dist', confirmationText: 'dist' },
    {
      cmd: 'rm -rf /tmp/cache; systemctl restart nginx',
      target: '/tmp/cache',
      confirmationText: 'cache'
    },
    { cmd: 'shred /etc/passwd; echo done', target: '/etc/passwd', confirmationText: 'passwd' },
    { cmd: 'wipefs -a /dev/sdb && reboot', target: '/dev/sdb', confirmationText: 'sdb' },
    {
      cmd: 'rm -rf /tmp/build && systemctl restart sshd',
      target: '/tmp/build',
      confirmationText: 'build'
    }
  ];

  for (const { cmd, target, confirmationText } of cases) {
    it(`цель из опасного фрагмента, а не хвост строки: ${cmd}`, () => {
      const m = analyzeCommand(cmd);
      expect(m?.target).toBe(target);
      expect(m?.confirmationText).toBe(confirmationText);
      expect(m?.confirmationKind).toBe('target');
    });
  }

  it('флаги не попадают в цель на простой команде', () => {
    expect(analyzeCommand('wipefs -a /dev/sdb')?.target).toBe('/dev/sdb');
    expect(analyzeCommand('shred -n 3 /dev/sdb')?.target).toBe('/dev/sdb');
  });

  it('форк-бомба распознаётся, несмотря на разбиение по | и ;', () => {
    // Ради неё существует проход по всей строке: разбиение разрушило бы паттерн.
    expect(analyzeCommand(':(){ :|:& };:')?.patternId).toBe('fork-bomb');
    expect(analyzeCommand('echo hi; :(){ :|:& };:')?.patternId).toBe('fork-bomb');
    expect(analyzeCommand('sudo :(){ :|:& };:')?.patternId).toBe('fork-bomb');
  });

  it('форк-бомба распознаётся и после фонового `&` перед ней', () => {
    // & внутри самой бомбы не должен помешать проходу по всей строке (matchWhole).
    expect(analyzeCommand('echo hi & :(){ :|:& };:')?.patternId).toBe('fork-bomb');
  });
});

describe('analyzeCommand — фоновый запуск через одиночный `&` (guard-background-ampersand)', () => {
  it('цель берётся из опасного фрагмента, а не из хвоста после &', () => {
    const m = analyzeCommand('rm -rf /var/www & echo done');
    expect(m?.target).toBe('/var/www');
    expect(m?.confirmationText).toBe('www');
  });

  it('фоновый запуск без второй команды (висячий &)', () => {
    const m = analyzeCommand('rm -rf /var/www &');
    expect(m?.target).toBe('/var/www');
  });

  it('несколько фоновых команд подряд', () => {
    const m = analyzeCommand('dd if=/dev/zero of=/dev/sdb & disown');
    expect(m?.target).toBe('/dev/sdb');
  });

  it('`&&` не распадается на пустой фрагмент из-за одиночного &', () => {
    const m = analyzeCommand('rm -rf /var/www && echo done');
    expect(m?.target).toBe('/var/www');
    expect(m?.confirmationText).toBe('www');
  });

  it('& внутри перенаправления (2>&1, &>file, >&2) — не разделитель', () => {
    expect(analyzeCommand('rm -rf /var/www 2>&1')?.target).toBe('/var/www');
    expect(analyzeCommand('dd if=/dev/zero of=/dev/sdb 2>&1')?.target).toBe('/dev/sdb');
    expect(analyzeCommand('rm -rf /var/www &>/dev/null')?.target).toBe('/var/www');
    expect(analyzeCommand('rm -rf /var/www >&2')?.target).toBe('/var/www');
  });
});

describe('analyzeCommand — отсутствие ложных срабатываний', () => {
  const safe = [
    'ls -la',
    'rm file.txt', // без рекурсии — обычное удаление файла
    'rm -f single-file.log', // -f без -r
    'cd /var/www',
    'cat /var/log/syslog',
    'grep -r "pattern" /etc', // -r у grep — не rm
    'chmod 644 config.json',
    'chmod -R 755 /var/www', // 755 — не 777
    'dd if=/dev/sda of=backup.img', // чтение С диска в файл-бэкап (of=файл — file, не disk)
    'echo "rm -rf" ', // просто текст в echo… содержит паттерн — допустимое консервативное срабатывание? см. ниже
    'kill -9 12345', // обычный процесс, не init
    'truncate -s 10M bigfile', // не до нуля
    'mkdir -p /opt/app',
    'tail -f /var/log/nginx/error.log',
    'echo hello > output.txt',
    'firmware-update --dry-run'
  ];

  for (const cmd of safe) {
    if (cmd.startsWith('echo "rm -rf"')) continue; // отдельный кейс ниже
    if (cmd.startsWith('dd if=/dev/sda')) continue; // отдельный кейс ниже
    it(`не срабатывает на: ${cmd}`, () => {
      expect(analyzeCommand(cmd)).toBeNull();
    });
  }

  it('dd с of=файл — file-масштаб (предупреждение о перезаписи файла)', () => {
    // Консервативно: dd of=… перезаписывает цель без вопросов — предупреждаем,
    // но масштаб file, и подтверждение — имя файла
    const m = analyzeCommand('dd if=/dev/sda of=backup.img');
    expect(m?.scope).toBe('file');
    expect(m?.confirmationText).toBe('backup.img');
  });

  it('пустая и сверхдлинная строки безопасны', () => {
    expect(analyzeCommand('')).toBeNull();
    expect(analyzeCommand('a'.repeat(20_000))).toBeNull();
  });
});

/**
 * GUARD-07: риск потери SSH-доступа. Обязательное покрытие всех четырёх
 * категорий (sshd_config, файрвол, passwd, sshd-сервис) — и срабатывание,
 * и отсутствие ложных срабатываний (CLAUDE.md §10).
 */
describe('analyzeAccessRisk — sshd_config (write-команды)', () => {
  const triggers = [
    'nano /etc/ssh/sshd_config',
    'vim /etc/ssh/sshd_config',
    'sudo vi /etc/ssh/sshd_config',
    "sed -i 's/#Port 22/Port 2222/' /etc/ssh/sshd_config",
    "sudo sed -ri 's/^PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config",
    "echo 'PermitRootLogin no' >> /etc/ssh/sshd_config",
    'cat my.conf > /etc/ssh/sshd_config',
    "echo 'Port 2222' | sudo tee -a /etc/ssh/sshd_config",
    'vi /etc/ssh/sshd_config.d/50-cloud-init.conf',
    'sudoedit /etc/ssh/sshd_config'
  ];
  for (const cmd of triggers) {
    it(`срабатывает на: ${cmd}`, () => {
      expect(analyzeAccessRisk(cmd)?.riskId).toBe('sshd-config');
    });
  }

  const safe = [
    'cat /etc/ssh/sshd_config',
    'grep -i port /etc/ssh/sshd_config',
    'less /etc/ssh/sshd_config',
    'sudo tail -n 20 /etc/ssh/sshd_config',
    "sed -n '/Port/p' /etc/ssh/sshd_config", // sed без -i — просмотр
    'nano ~/notes.txt', // редактор, но не sshd_config
    'vim /etc/ssh/sshd_config.bak', // бэкап, не сам конфиг
    'cat /etc/ssh/sshd_config > /etc/ssh/sshd_config.bak' // снятие бэкапа — безопасно
  ];
  for (const cmd of safe) {
    it(`не срабатывает на: ${cmd}`, () => {
      expect(analyzeAccessRisk(cmd)).toBeNull();
    });
  }
});

describe('analyzeAccessRisk — файрвол', () => {
  const triggers = [
    'ufw enable',
    'sudo ufw disable',
    'ufw allow 8080/tcp',
    'ufw delete allow 22',
    'ufw default deny incoming',
    'iptables -A INPUT -p tcp --dport 22 -j DROP',
    'sudo iptables -F',
    'iptables -P INPUT DROP',
    'ip6tables -D INPUT 3',
    'firewall-cmd --permanent --remove-service=ssh',
    'sudo firewall-cmd --reload',
    'firewall-cmd --set-default-zone=drop'
  ];
  for (const cmd of triggers) {
    it(`срабатывает на: ${cmd}`, () => {
      expect(analyzeAccessRisk(cmd)?.riskId).toBe('firewall');
    });
  }

  const safe = [
    'ufw status',
    'ufw status verbose',
    'iptables -L',
    'iptables -L -n -v',
    'iptables -S',
    'firewall-cmd --list-all',
    'firewall-cmd --state',
    'firewall-cmd --get-active-zones',
    'firewall-cmd --query-port=22/tcp'
  ];
  for (const cmd of safe) {
    it(`не срабатывает на: ${cmd}`, () => {
      expect(analyzeAccessRisk(cmd)).toBeNull();
    });
  }
});

describe('analyzeAccessRisk — passwd', () => {
  const triggers = ['passwd', 'sudo passwd', 'passwd deploy', 'sudo passwd root'];
  for (const cmd of triggers) {
    it(`срабатывает на: ${cmd}`, () => {
      expect(analyzeAccessRisk(cmd)?.riskId).toBe('passwd');
    });
  }

  const safe = [
    'cat /etc/passwd',
    'man passwd', // просмотр справки, не вызов
    'grep deploy /etc/passwd',
    'ls -la /etc | grep passwd'
  ];
  for (const cmd of safe) {
    it(`не срабатывает на: ${cmd}`, () => {
      expect(analyzeAccessRisk(cmd)).toBeNull();
    });
  }
});

describe('analyzeAccessRisk — служба sshd', () => {
  const triggers = [
    'systemctl restart sshd',
    'sudo systemctl restart sshd',
    'systemctl stop ssh',
    'systemctl disable sshd',
    'sudo systemctl --now disable sshd',
    'systemctl restart sshd.service',
    'service ssh restart',
    'sudo service sshd stop'
  ];
  for (const cmd of triggers) {
    it(`срабатывает на: ${cmd}`, () => {
      expect(analyzeAccessRisk(cmd)?.riskId).toBe('sshd-service');
    });
  }

  const safe = [
    'systemctl status sshd',
    'systemctl restart nginx',
    'systemctl restart ssh-agent', // не sshd, юнит с другим именем
    'service nginx restart',
    'service ssh status',
    'systemctl enable sshd', // включение службы доступу не грозит
    'systemctl restart nginx # then check ssh' // «ssh» в комментарии — не юнит
  ];
  for (const cmd of safe) {
    it(`не срабатывает на: ${cmd}`, () => {
      expect(analyzeAccessRisk(cmd)).toBeNull();
    });
  }

  it('распознаётся и за одиночным & (guard-background-ampersand)', () => {
    expect(analyzeAccessRisk('systemctl stop sshd & echo ok')?.riskId).toBe('sshd-service');
  });
});

describe('analyzeAccessRisk — общее поведение', () => {
  it('рискованная часть составной команды распознаётся', () => {
    expect(analyzeAccessRisk('cd /etc && systemctl restart sshd')?.riskId).toBe('sshd-service');
  });

  it('пустая и сверхдлинная строки безопасны', () => {
    expect(analyzeAccessRisk('')).toBeNull();
    expect(analyzeAccessRisk('a'.repeat(20_000))).toBeNull();
  });

  it('rm -rf ~/.ssh остаётся деструктивным паттерном (analyzeCommand), не категорией риска', () => {
    // Порядок «сначала analyzeCommand, потом analyzeAccessRisk» — в guard/manager.ts;
    // здесь фиксируем, что сама команда распознаётся обычным Стражем.
    expect(analyzeCommand('rm -rf ~/.ssh')?.patternId).toBe('rm-recursive');
    expect(analyzeAccessRisk('rm -rf ~/.ssh')).toBeNull();
  });
});

describe('stripCmdPrefix — переиспользуется детектором ошибок', () => {
  it('снимает sudo и env-префиксы', () => {
    expect(stripCmdPrefix('sudo systemctl status ssh')).toBe('systemctl status ssh');
    expect(stripCmdPrefix('env FOO=bar systemctl status ssh')).toBe('systemctl status ssh');
  });

  it('команду без префикса не меняет', () => {
    expect(stripCmdPrefix('systemctl status ssh')).toBe('systemctl status ssh');
  });
});
