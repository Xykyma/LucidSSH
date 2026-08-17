/**
 * Страж опасных команд — паттерны (GUARD-01, OQ-05: список ровно по ТЗ).
 * Файл обязан покрываться тестами (CLAUDE.md §10) и меняться только вместе с ними.
 *
 * Страж — средство предупреждения о РАСПОЗНАННЫХ опасных командах, не гарантия
 * блокировки любой разрушительной операции (§15 Security_Guide) — это ограничение
 * отражается в UI-текстах.
 */

import type { AccessRiskId, DangerPatternId } from '@shared/guard';

export type DangerScope = 'file' | 'directory' | 'disk' | 'other';

export interface DangerMatch {
  /** id паттерна — для i18n-объяснения (guard.patterns.<id>) */
  patternId: DangerPatternId;
  /** Реальная цель из команды (GUARD-03) */
  target: string;
  scope: DangerScope;
  /** 'target' — подтверждение именем объекта, 'word' — общим словом подтверждения. */
  confirmationKind: 'target' | 'word';
  /** Для kind='target' — итоговый текст. Для kind='word' — внутренний плейсхолдер
   *  (CONFIRM_WORD), реальный локализованный текст подставляет guard/manager.ts. */
  confirmationText: string;
}

interface GuardPattern {
  id: DangerPatternId;
  re: RegExp;
  /**
   * Матчить ТОЛЬКО строку целиком, не разбивая её на простые команды.
   * Ставится паттерну, в чьём регекспе `;` `&&` `||` `|` — значащие символы:
   * разбиение по ним разрушило бы сам паттерн (единственный такой — форк-бомба).
   * Всем остальным флаг НЕ нужен: их матч по всей строке ломает цель — якорь `$`
   * захватывает хвост всей строки вместо объекта опасного фрагмента (GUARD-03),
   * и `rm -rf /var/www; echo done` просит подтвердить словом «done».
   */
  matchWhole?: true;
  scope: DangerScope | ((m: RegExpMatchArray) => DangerScope);
  /** Извлечение цели из совпадения; null → вся команда */
  target: (m: RegExpMatchArray) => string | null;
}

/** Хвостовое перенаправление без пробела внутри токена: `2>&1`, `>&2`, `&>file`, `&>>file`,
 *  `>file`, `2>>file`. Требует пробела ПЕРЕД собой — не трогает слитные случаи вроде
 *  `/var/www2>&1` (консервативно: как и с кавычками, не пытаемся разобрать всё).
 *  Применяется только при извлечении цели (rm/shred/wipefs) — НЕ к фрагменту, который
 *  матчат сами паттерны: `redirect-device` (`echo x >/dev/sda`) как раз ищет `>` + путь,
 *  и снимать редирект до его проверки — значит спрятать от Стража ровно то, что он ищет. */
const TRAILING_REDIRECT_RE = /\s+(?:\d*>{1,2}&\d+|&>{1,2}\S*|\d*>{1,2}\S+)$/;

/** Снять один или несколько хвостовых редиректов подряд (`cmd > out.log 2>&1`). */
function stripTrailingRedirects(s: string): string {
  let result = s;
  for (let next = result.replace(TRAILING_REDIRECT_RE, ''); next !== result; ) {
    result = next;
    next = result.replace(TRAILING_REDIRECT_RE, '');
  }
  return result;
}

/** Последний токен строки аргументов (цель команд вида shred/wipefs). Хвостовой
 *  редирект снимается до разбиения на токены — иначе целью станет `2>&1`, а не файл. */
function lastToken(args: string | undefined): string | null {
  if (!args) return null;
  const tokens = stripTrailingRedirects(args.trim()).trim().split(/\s+/);
  const last = tokens[tokens.length - 1];
  return last && !last.startsWith('-') ? last : null;
}

/** Последний сегмент пути — им подтверждают удаление («www» для /var/www). */
function lastSegment(path: string): string {
  const cleaned = path.replace(/["']/g, '').replace(/\/+$/, '');
  const seg = cleaned.split('/').filter(Boolean).pop();
  return seg ?? cleaned;
}

const CONFIRM_WORD = 'ПОДТВЕРЖДАЮ';

/**
 * Паттерны применяются к каждой команде в составной строке (после разбиения
 * по ; && || |) — кроме помеченных `matchWhole`, которые матчатся только по
 * строке целиком. Порядок важен: первый совпавший выигрывает.
 */
const PATTERNS: GuardPattern[] = [
  {
    // rm с рекурсивным или форсированным флагом: rm -rf X, rm -r X, rm --recursive X
    // Хвост вида `2>&1`/`>file` после цели опционально поглощается без захвата —
    // иначе им же и подтверждали бы удаление (см. TRAILING_REDIRECT_RE выше).
    id: 'rm-recursive',
    re: new RegExp(
      String.raw`(?:^|\s)rm\s+(?=[^\n]*(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive))[^\n]*?\s(?!-)(\S+)` +
        String.raw`(?:\s+(?:\d*>{1,2}&\d+|&>{1,2}\S*|\d*>{1,2}\S+))*\s*$`
    ),
    scope: (m) => (m[1] === '/' || m[1] === '/*' ? 'disk' : 'directory'),
    target: (m) => m[1] ?? null
  },
  {
    // dd с записью в устройство или файл: dd if=... of=/dev/sda
    id: 'dd-write',
    re: /(?:^|\s)dd\s+[^\n]*of=(\S+)/,
    scope: (m) => (m[1]?.startsWith('/dev/') ? 'disk' : 'file'),
    target: (m) => m[1] ?? null
  },
  {
    // mkfs любого вида: mkfs /dev/sdb1, mkfs.ext4 /dev/sda
    id: 'mkfs',
    re: /(?:^|\s)mkfs(?:\.\w+)?\s+(?:-\S+\s+)*(\S+)/,
    scope: 'disk',
    target: (m) => m[1] ?? null
  },
  {
    // chmod -R 777 (полностью открытые права рекурсивно)
    id: 'chmod-777',
    re: /(?:^|\s)chmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+)0?777\s+(\S+)|(?:^|\s)chmod\s+0?777\s+(-[a-zA-Z]*R[a-zA-Z]*)\s+(\S+)/,
    scope: 'directory',
    target: (m) => m[1] ?? m[3] ?? null
  },
  {
    // truncate существующего файла до 0: truncate -s 0 file
    id: 'truncate',
    re: /(?:^|\s)truncate\s+[^\n]*-s\s*0\s+(\S+)/,
    scope: 'file',
    target: (m) => m[1] ?? null
  },
  {
    // Перенаправление в блочное устройство: > /dev/sda, >> /dev/nvme0n1
    id: 'redirect-device',
    re: />+\s*(\/dev\/(?:sd[a-z]\d*|hd[a-z]\d*|nvme\d+n\d+(?:p\d+)?|vd[a-z]\d*|mmcblk\d+(?:p\d+)?))/,
    scope: 'disk',
    target: (m) => m[1] ?? null
  },
  {
    // shred устройства или файла: цель — последний аргумент (флаги могут иметь
    // отдельные значения вроде «-n 3»)
    id: 'shred',
    re: /(?:^|\s)shred\s+(.+)$/,
    scope: (m) => (lastToken(m[1]) ?? '').startsWith('/dev/') ? 'disk' : 'file',
    target: (m) => lastToken(m[1])
  },
  {
    // wipefs — стирание сигнатур ФС
    id: 'wipefs',
    re: /(?:^|\s)wipefs\s+(.+)$/,
    scope: 'disk',
    target: (m) => lastToken(m[1])
  },
  {
    // fork-бомба. matchWhole: содержит `|` и `;` как значащие символы —
    // разбиение составной команды разорвало бы паттерн на части.
    id: 'fork-bomb',
    re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    matchWhole: true,
    scope: 'other',
    target: () => null
  },
  {
    // DROP DATABASE / DROP TABLE в командной строке (mysql -e, psql -c)
    id: 'drop-database',
    re: /drop\s+(?:database|table)\s+(?:if\s+exists\s+)?[`"']?(\w+)/i,
    scope: 'other',
    target: (m) => m[1] ?? null
  },
  {
    // kill -9 1 (init) или killall5 — обрушение системы
    id: 'kill-init',
    re: /(?:^|\s)kill\s+-(?:9|KILL)\s+1(?:\s|$)/,
    scope: 'other',
    target: () => null
  }
];

// --- GUARD-07: риск потери SSH-доступа -------------------------------------
// Отдельная категория: не деструктивные команды, а действия, способные разорвать
// SSH-доступ к серверу. Проверяется ТОЛЬКО если analyzeCommand ничего не нашёл
// (порядок — в guard/manager.ts): двойного предупреждения не бывает.

export interface AccessRiskMatch {
  /** id категории риска — для i18n-текста (guard.accessRisk.explain.<id>) */
  riskId: AccessRiskId;
}

/** Путь конфигурации SSH-сервера (включая drop-in каталог sshd_config.d).
 *  Граница (?=\s|$) в конце — чтобы sshd_config.bak и т.п. не матчились. */
const SSHD_CONFIG_PATH = String.raw`\/etc\/ssh\/sshd_config(?:\.d\/\S+)?(?=\s|$)`;

const ACCESS_RISK_PATTERNS: { id: AccessRiskId; re: RegExp }[] = [
  {
    // Write-доступ к sshd_config: редакторы, sed -i, перенаправление >/>>, tee.
    // Просмотровые команды (cat/grep/less/tail, sed без -i) не матчатся намеренно.
    id: 'sshd-config',
    re: new RegExp(
      `(?:^|\\s)(?:vi|vim|nvim|nano|pico|emacs|ed|joe|mcedit|micro|sudoedit)\\s+[^\\n]*${SSHD_CONFIG_PATH}` +
        `|(?:^|\\s)sed(?=[^\\n]*\\s-[a-zA-Z]*i)[^\\n]*${SSHD_CONFIG_PATH}` +
        `|>{1,2}\\s*${SSHD_CONFIG_PATH}` +
        `|(?:^|\\s)tee\\s+(?:-\\S+\\s+)*${SSHD_CONFIG_PATH}`
    )
  },
  {
    // Изменяющие подкоманды файрволов; просмотровые (ufw status, iptables -L,
    // firewall-cmd --list-*/--get-*/--query-*/--state) не матчатся.
    id: 'firewall',
    re: new RegExp(
      String.raw`(?:^|\s)ufw\s+(?:--\S+\s+)*(?:enable|disable|reload|reset|default|logging|allow|deny|reject|limit|delete|insert|prepend|route)(?:\s|$)` +
        String.raw`|(?:^|\s)(?:iptables|ip6tables)(?=[^\n]*\s(?:-[ADIRFXPN]|--(?:append|delete|insert|replace|flush|policy|new-chain|delete-chain))(?:\s|$))` +
        String.raw`|(?:^|\s)firewall-cmd(?=[^\n]*\s--(?:add-|remove-|set-|new-|delete-|change-|reload(?:\s|$)|panic-(?:on|off)|runtime-to-permanent))`
    )
  },
  {
    // Любой вызов passwd в позиции команды (sudo-префикс снят до матча).
    // Якорь ^ отсекает упоминания: man passwd, cat /etc/passwd, grep passwd.
    id: 'passwd',
    re: /^passwd(?:\s|$)/
  },
  {
    // Остановка/перезапуск/отключение службы SSH. enable/status не матчатся.
    id: 'sshd-service',
    re: new RegExp(
      // (?:[^#\s]+\s+)* — список юнитов до ssh/sshd; # исключён, чтобы слово
      // «ssh» в хвостовом комментарии не давало ложного срабатывания.
      String.raw`(?:^|\s)systemctl\s+(?:--\S+\s+)*(?:stop|restart|disable)\s+(?:[^#\s]+\s+)*(?:ssh|sshd)(?:\.service|\.socket)?(?:\s|$)` +
        String.raw`|(?:^|\s)service\s+(?:ssh|sshd)\s+(?:stop|restart)(?:\s|$)`
    )
  }
];

/**
 * Анализ риска потери SSH-доступа (GUARD-07): правка sshd_config, изменение
 * правил файрвола, смена пароля, остановка/перезапуск sshd. В отличие от
 * analyzeCommand — предупреждение-рекомендация, не type-to-confirm блокировка.
 */
export function analyzeAccessRisk(command: string): AccessRiskMatch | null {
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed.length > 10_000) return null;
  for (const part of splitCompound(trimmed)) {
    const unprefixed = part.replace(CMD_PREFIX_RE, '');
    for (const pattern of ACCESS_RISK_PATTERNS) {
      if (pattern.re.test(unprefixed) || pattern.re.test(part)) {
        return { riskId: pattern.id };
      }
    }
  }
  return null;
}

/** Разбиение составной команды на простые (; && || | &) без учёта кавычек — консервативно.
 *  Одиночный `&` (фоновый запуск) — разделитель наравне с `;`/`&&`/`||`/`|`; `&&` матчится
 *  раньше него в альтернативе, иначе `a && b` распалось бы на `a`, «», `b`. Лукэраунды
 *  исключают `&`, склеенный с `>` (`2>&1`, `&>file`, `>&2`) — там `&` часть перенаправления,
 *  не разделитель. Фрагмент отдаётся паттернам как есть, вместе с редиректом: его снятие —
 *  забота точки извлечения цели (rm-recursive, lastToken), а не этой функции — `redirect-device`
 *  как раз матчит `>`+путь, и снимать его здесь означало бы прятать цель от самого Стража
 *  (см. spec .scratch/guard-background-ampersand). Кавычки по-прежнему не учитываются —
 *  осознанное упрощение.
 *  Экспорт: переиспользуется детекцией эскалации шелла (shellIntegration.ts). */
export function splitCompound(command: string): string[] {
  return command
    .split(/;|&&|\|\||\||(?<!>)&(?!>)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Анализ команды перед отправкой на сервер (GUARD-02).
 * Возвращает первый распознанный опасный фрагмент либо null.
 */
export function analyzeCommand(command: string): DangerMatch | null {
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed.length > 10_000) return null;

  // Проход 1: паттерны, разрушаемые разбиением по |/; (fork-бомба) — по всей строке.
  const wholeMatch = matchPatterns(trimmed, WHOLE_PATTERNS);
  if (wholeMatch) return wholeMatch;

  // Проход 2: все остальные — только по фрагментам, чтобы цель бралась из
  // опасного фрагмента, а не с конца всей строки (GUARD-03).
  for (const part of splitCompound(trimmed)) {
    const match = matchPatterns(part, PART_PATTERNS);
    if (match) return match;
  }
  return null;
}

/** sudo/env-префиксы не должны прятать команду. */
const CMD_PREFIX_RE = /^(?:sudo\s+|env\s+\S+=\S+\s+)+/;

/** Снять sudo/env-префикс — переиспользуется вне Стража (детектор ошибок). */
export function stripCmdPrefix(command: string): string {
  return command.replace(CMD_PREFIX_RE, '');
}

/** Две непересекающиеся группы: каждый паттерн проверяется ровно в одном проходе. */
const WHOLE_PATTERNS = PATTERNS.filter((p) => p.matchWhole === true);
const PART_PATTERNS = PATTERNS.filter((p) => p.matchWhole !== true);

function matchPatterns(part: string, patterns: GuardPattern[]): DangerMatch | null {
  const unprefixed = part.replace(CMD_PREFIX_RE, '');
  for (const pattern of patterns) {
    const m = unprefixed.match(pattern.re) ?? part.match(pattern.re);
    if (!m) continue;
    const rawTarget = pattern.target(m);
    const scope = typeof pattern.scope === 'function' ? pattern.scope(m) : pattern.scope;
    const target = rawTarget ?? part;
    return {
      patternId: pattern.id,
      target,
      scope,
      confirmationKind: rawTarget ? 'target' : 'word',
      confirmationText: rawTarget ? lastSegment(rawTarget) : CONFIRM_WORD
    };
  }
  return null;
}

export { CONFIRM_WORD };
