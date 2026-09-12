import type { ClientChannel } from 'ssh2';
import type { AuthMethod, HostInput } from '@shared/hosts';
import type { TestConnectionResult } from '@shared/ssh';
import { loadPrivateKey, PrivateKeyError } from './keys';
import { getHost } from '../hosts/repository';
import { getSecretForConnection } from '../keychain';
import { openConnection, type Connection, type ConnectionCredentials } from './connection';
import { forwardOut } from './forwardOut';

/**
 * Пробное подключение из формы «Новое подключение» (кнопка «Проверить соединение»).
 * Проверяет достижимость сервера и аутентификацию, НЕ создаёт сессию и не
 * передаёт данные — сразу отключается. Секрет живёт только в области
 * видимости этой функции (§9.9 гайда).
 *
 * Ключ хоста проверяется на ОБОИХ хопах той же политикой, что и в сессии
 * (ADR-0016, `.scratch/host-key-decision/spec.md` PR-2): совпал с known_hosts —
 * молча пускаем; незнакомый или изменившийся — промпт SSH-03/04
 * (`purpose: 'test'`, см. `FingerprintModal`), запись только после accept.
 * Раньше целевой хост не проверялся вовсе, а bastion — только молча по
 * `matchesKnownKey`, без возможности подтвердить новый отпечаток отсюда; это
 * било SEC-03/SSH-07 и роняло тест на только что назначенном jump-хосте,
 * который ни разу не открывали напрямую (User Story 3).
 *
 * При заданном `proxyJumpHostId` (SSH-05) прогоняет ту же двухэтапную цепочку,
 * что и `sessionManager.ts` (bastion → forwardOut → target), с тем же
 * различением этапа ошибки: провал на bastion возвращается с `step: 'jump'`,
 * чтобы форма могла показать «не удалось подключиться к bastion», а не
 * запутывающее сообщение про целевой хост. Отказ по отпечатку bastion остаётся
 * `clog.jump.hostkeyUnknown` (тот же ключ, что и раньше); у целевого хоста —
 * свой `clog.error.hostkeyRejected`, не про jump.
 *
 * `hostId` — id редактируемого хоста (undefined при создании нового), нужен
 * только для проверки self-reference (см. sessionManager.ts —
 * `establishJumpTunnel`, тот же случай: миграция v2 могла резолвнуть старый
 * текстовый `proxy_jump` на имя самого хоста).
 *
 * Одно Соединение до `ready` (базовый конфиг, перевод err.level, hostVerifier,
 * keyboard-interactive, пустой пароль) — теперь общий с `sessionManager.ts`
 * модуль `connection.ts` (ADR-0017, `.scratch/open-connection/spec.md` PR-2).
 * Здесь остаётся только оркестрация двух хопов и разбор `outcome` в
 * `errorKey`/`step` для формы — перевод причины у двух вызывающих законно
 * разный (решение 5 спеки).
 */
export async function testConnection(
  input: HostInput,
  secret: string | undefined,
  hostId?: number
): Promise<TestConnectionResult> {
  let jumpConnection: Connection | undefined;
  let sock: ClientChannel | undefined;

  if (input.proxyJumpHostId !== undefined) {
    if (input.proxyJumpHostId === hostId) {
      return { ok: false, errorKey: 'clog.jump.selfReference', step: 'jump' };
    }
    const bastion = getHost(input.proxyJumpHostId);
    if (!bastion) {
      return { ok: false, errorKey: 'clog.jump.hostMissing', step: 'jump' };
    }

    let bastionSecret: string | undefined;
    try {
      bastionSecret = (await getSecretForConnection(bastion.id)) ?? undefined;
    } catch {
      bastionSecret = undefined;
    }

    // Пароль bastion не сохранён — в сессии (sessionManager.ts) это повод
    // спросить его интерактивно в терминале, но здесь терминала нет (тест
    // выполняется прямо из формы, до открытия сессии). Не пытаемся подключиться
    // с пустым паролем — итоговая «Ошибка аутентификации» выглядела бы так же,
    // как неверный пароль, хотя причина другая и чинится иначе (сохранить
    // пароль bastion, открыв его отдельно). Ключ без сохранённого passphrase
    // (undefined тоже) — легитимный случай (незашифрованный ключ), не блокируем.
    if (bastion.authMethod === 'password' && bastionSecret === undefined) {
      return { ok: false, errorKey: 'clog.jump.hostSecretMissing', step: 'jump' };
    }

    const bastionCredentials = resolveCredentials(bastion, bastionSecret);
    if (!bastionCredentials.ok) return { ok: false, errorKey: bastionCredentials.errorKey, step: 'jump' };

    const jumpResult = await connectOnce(bastion, bastionCredentials.credentials, 'jump');
    if (!jumpResult.ok) return { ok: false, errorKey: jumpResult.errorKey, step: 'jump' };
    jumpConnection = jumpResult.connection;

    try {
      sock = await forwardOut(jumpConnection, input.address, input.port);
    } catch {
      // Типичная причина — bastion запрещает проброс (AllowTcpForwarding no)
      // или целевой хост недоступен уже из его сети (см. sessionManager.ts).
      jumpConnection.end();
      return { ok: false, errorKey: 'clog.jump.tunnelFailed', step: 'jump' };
    }
  }

  const targetCredentials = resolveCredentials(input, secret);
  if (!targetCredentials.ok) {
    jumpConnection?.end();
    return { ok: false, errorKey: targetCredentials.errorKey };
  }

  const targetResult = await connectOnce(input, targetCredentials.credentials, 'target', sock);
  jumpConnection?.end();
  if (!targetResult.ok) return { ok: false, errorKey: targetResult.errorKey };
  targetResult.connection.end();
  return { ok: true };
}

/** Минимум полей, нужных для одной попытки подключения — общий для целевого
 *  хоста (`HostInput`) и bastion (`Host`, у него есть лишние поля, но они
 *  совместимы структурно). */
interface ConnectTarget {
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  keyPath?: string;
}

type ResolvedCredentials =
  | { ok: true; credentials: ConnectionCredentials }
  | { ok: false; errorKey: string };

/** Читает приватный ключ (если метод входа — ключ) и переводит секрет в
 *  `ConnectionCredentials` для `connection.ts`. Вынесено сюда из `connectOnce`
 *  (решение 6 спеки PR-2) — чтение ключа законно разное у сессии (цикл с
 *  passphrase) и теста (одна попытка), `connection.ts` принимает уже
 *  решённые креды. */
function resolveCredentials(target: ConnectTarget, secret: string | undefined): ResolvedCredentials {
  if (target.authMethod === 'key') {
    try {
      const privateKey = loadPrivateKey(target.keyPath ?? '', secret ?? undefined);
      return { ok: true, credentials: { kind: 'key', privateKey, passphrase: secret ?? undefined } };
    } catch (err) {
      const reason = err instanceof PrivateKeyError ? err.reason : 'unparsable';
      return { ok: false, errorKey: `clog.keyError.${reason}` };
    }
  }
  return { ok: true, credentials: { kind: 'password', password: secret ?? '' } };
}

type ConnectOnceResult = { ok: true; connection: Connection } | { ok: false; errorKey: string };

/** Один хоп тестового подключения: делегирует `connection.ts` и переводит его
 *  `outcome` в `errorKey`, законный для формы (bastion — `clog.jump.hostkeyUnknown`,
 *  целевой хост — `clog.error.hostkeyRejected`, решение 5 спеки). При успехе
 *  оставляет Соединение открытым — вызывающая сторона либо использует его как
 *  транспорт для forwardOut (bastion), либо закрывает (целевой хост, тест
 *  окончен); закрывать на провале не нужно — `outcome` разрешается только на
 *  `close`, Соединение уже мертво. */
function connectOnce(
  target: ConnectTarget,
  credentials: ConnectionCredentials,
  role: 'target' | 'jump',
  sock?: ClientChannel
): Promise<ConnectOnceResult> {
  const hostKeyRejectedErrorKey = role === 'jump' ? 'clog.jump.hostkeyUnknown' : 'clog.error.hostkeyRejected';

  const { connection, outcome } = openConnection(
    { name: target.name, address: target.address, port: target.port, username: target.username },
    credentials,
    { purpose: 'test', sock }
  );

  return outcome.then((result) => {
    if (result.ok) return { ok: true, connection };
    if (result.reason === 'hostkey-rejected') return { ok: false, errorKey: hostKeyRejectedErrorKey };
    return { ok: false, errorKey: `clog.error.${result.reason}` };
  });
}
