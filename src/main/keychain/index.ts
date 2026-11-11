import type { HostCredential } from '../hosts/repository';
import { getProfileId } from '../startup/profileIdentity';
import { SecretStoreUnavailableError } from './errors';

/**
 * Единственное место работы с секретами (SEC-01, §10 Security_Guide).
 * Пароли и passphrase — только в системном Хранилище секретов (Windows Credential
 * Manager / libsecret). Значение секрета НИКОГДА не уходит в renderer: наружу
 * отдаётся только факт наличия (hasSecret).
 *
 * Адрес записи (NFR-05, тикет 04): установленная версия и другие платформы —
 * прежний `LucidSSH/{hostId}`, миграция существующих записей не нужна;
 * portable-профиль — `LucidSSH/{profileId}/{credentialId}`, поэтому одинаковые
 * числовые id в разных профилях и независимых копиях не встречаются с чужими
 * записями, а скопированная вместе с профилем БД сохраняет общий секрет на том
 * же ПК. Одного числового hostId для portable-адресации недостаточно — все
 * операции принимают полную идентичность записи (HostCredential).
 *
 * keytar грузится лениво: на Linux без libsecret статический import ронял бы
 * main при старте. Любой сбой (загрузки или вызова) — SecretStoreUnavailableError.
 */

const CRED_SERVICE = 'LucidSSH';

type Keytar = typeof import('keytar');

/** Установленная версия — числовой id хоста; portable — profileId/credentialId. */
function accountFor(key: HostCredential): string {
  const profileId = getProfileId();
  return profileId !== null ? `${profileId}/${key.credentialId}` : String(key.hostId);
}

async function withStore<T>(fn: (keytar: Keytar) => Promise<T>): Promise<T> {
  try {
    return await fn((await import('keytar')).default);
  } catch (err) {
    throw new SecretStoreUnavailableError(err);
  }
}

export function setSecret(key: HostCredential, secret: string): Promise<void> {
  return withStore((k) => k.setPassword(CRED_SERVICE, accountFor(key), secret));
}

/** Только для main (подключение SSH). Не подключать к IPC-ответам. */
export function getSecretForConnection(key: HostCredential): Promise<string | null> {
  return withStore((k) => k.getPassword(CRED_SERVICE, accountFor(key)));
}

export async function hasSecret(key: HostCredential): Promise<boolean> {
  return (await getSecretForConnection(key)) !== null;
}

export async function deleteSecret(key: HostCredential): Promise<void> {
  await withStore((k) => k.deletePassword(CRED_SERVICE, accountFor(key)));
}
