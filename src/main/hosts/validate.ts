import type { AuthMethod, HostInput } from '@shared/hosts';
import { IpcValidationError } from '../ipc/validate';

/**
 * Валидация HostInput в main process — независимо от проверок UI
 * (SEC-05, §25 Security_Guide): тип, формат, длина, диапазон.
 */

const MAX = {
  name: 100,
  address: 255,
  username: 64,
  keyPath: 500,
  note: 2000,
  secret: 1024,
  groupName: 60
} as const;

// Домен или IPv4/IPv6: буквы/цифры/дефис/точка/двоеточие/скобки IPv6
const ADDRESS_RE = /^[A-Za-z0-9.:\-_[\]]+$/;
// Имя пользователя POSIX-подобное
const USERNAME_RE = /^[A-Za-z0-9._-]+$/;

function str(v: unknown, name: string, maxLen: number, required: boolean): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw new IpcValidationError(`${name}: required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new IpcValidationError(`${name}: string expected`);
  if (v.length > maxLen) throw new IpcValidationError(`${name}: too long`);
  return v;
}

export function validateHostInput(raw: unknown): HostInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new IpcValidationError('hostInput: object expected');
  }
  const r = raw as Record<string, unknown>;

  const name = str(r['name'], 'name', MAX.name, true)!.trim();
  if (name.length === 0) throw new IpcValidationError('name: empty');

  const address = str(r['address'], 'address', MAX.address, true)!.trim();
  if (!ADDRESS_RE.test(address)) throw new IpcValidationError('address: invalid format');

  const port = r['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new IpcValidationError('port: 1..65535 expected');
  }

  const username = str(r['username'], 'username', MAX.username, true)!.trim();
  if (!USERNAME_RE.test(username)) throw new IpcValidationError('username: invalid format');

  const authMethod = r['authMethod'];
  if (authMethod !== 'password' && authMethod !== 'key') {
    throw new IpcValidationError('authMethod: password|key expected');
  }

  const keyPath = str(r['keyPath'], 'keyPath', MAX.keyPath, authMethod === 'key');

  let groupId: number | undefined;
  if (r['groupId'] !== undefined && r['groupId'] !== null) {
    if (typeof r['groupId'] !== 'number' || !Number.isInteger(r['groupId']) || r['groupId'] < 1) {
      throw new IpcValidationError('groupId: positive integer expected');
    }
    groupId = r['groupId'];
  }

  let proxyJumpHostId: number | undefined;
  if (r['proxyJumpHostId'] !== undefined && r['proxyJumpHostId'] !== null) {
    if (
      typeof r['proxyJumpHostId'] !== 'number' ||
      !Number.isInteger(r['proxyJumpHostId']) ||
      r['proxyJumpHostId'] < 1
    ) {
      throw new IpcValidationError('proxyJumpHostId: positive integer expected');
    }
    proxyJumpHostId = r['proxyJumpHostId'];
  }

  const note = str(r['note'], 'note', MAX.note, false);

  const guardEnabled = r['guardEnabled'];
  if (typeof guardEnabled !== 'boolean') {
    throw new IpcValidationError('guardEnabled: boolean expected');
  }

  const historyEnabled = r['historyEnabled'];
  if (typeof historyEnabled !== 'boolean') {
    throw new IpcValidationError('historyEnabled: boolean expected');
  }

  return {
    name,
    address,
    port,
    username,
    authMethod: authMethod as AuthMethod,
    keyPath,
    groupId,
    proxyJumpHostId,
    note,
    guardEnabled,
    historyEnabled
  };
}

export function validateSecret(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new IpcValidationError('secret: string expected');
  if (v.length > MAX.secret) throw new IpcValidationError('secret: too long');
  return v;
}

export function validateGroupName(v: unknown): string {
  const name = str(v, 'groupName', MAX.groupName, true)!.trim();
  if (name.length === 0) throw new IpcValidationError('groupName: empty');
  return name;
}

export function validateId(v: unknown, name = 'id'): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new IpcValidationError(`${name}: positive integer expected`);
  }
  return v;
}

/**
 * Необязательный hostId «в контексте текущей сессии»: undefined/null — контекста
 * нет, `0` — сессия Быстрого подключения (HM-11), у которой нет записи в `hosts`
 * и, значит, нет серверной области видимости (см. SnippetSaveDialog: сохранить
 * серверный сниппет на сентинел нельзя). Все три случая нормализуются в
 * undefined — «только глобальная область» (SNIP-05/SNIP-06); остальное проходит
 * обычную строгую проверку validateId.
 */
export function validateOptionalHostId(v: unknown, name = 'hostId'): number | undefined {
  if (v === undefined || v === null || v === 0) return undefined;
  return validateId(v, name);
}
