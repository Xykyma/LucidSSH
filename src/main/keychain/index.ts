import { SecretStoreUnavailableError } from './errors';

/**
 * Единственное место работы с секретами (SEC-01, §10 Security_Guide).
 * Пароли и passphrase — только в системном Хранилище секретов (Windows Credential
 * Manager / libsecret) под ключом LucidSSH/{hostId}. Значение секрета НИКОГДА не
 * уходит в renderer: наружу отдаётся только факт наличия (hasSecret).
 *
 * keytar грузится лениво: на Linux без libsecret статический import ронял бы
 * main при старте. Любой сбой (загрузки или вызова) — SecretStoreUnavailableError.
 */

const CRED_SERVICE = 'LucidSSH';

type Keytar = typeof import('keytar');

async function withStore<T>(fn: (keytar: Keytar) => Promise<T>): Promise<T> {
  try {
    return await fn((await import('keytar')).default);
  } catch (err) {
    throw new SecretStoreUnavailableError(err);
  }
}

export function setSecret(hostId: number, secret: string): Promise<void> {
  return withStore((k) => k.setPassword(CRED_SERVICE, String(hostId), secret));
}

/** Только для main (подключение SSH). Не подключать к IPC-ответам. */
export function getSecretForConnection(hostId: number): Promise<string | null> {
  return withStore((k) => k.getPassword(CRED_SERVICE, String(hostId)));
}

export async function hasSecret(hostId: number): Promise<boolean> {
  return (await getSecretForConnection(hostId)) !== null;
}

export async function deleteSecret(hostId: number): Promise<void> {
  await withStore((k) => k.deletePassword(CRED_SERVICE, String(hostId)));
}
