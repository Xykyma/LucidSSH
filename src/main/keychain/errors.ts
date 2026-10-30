import { SECRET_STORE_UNAVAILABLE } from '@shared/hosts';

/**
 * Отказ Хранилища секретов (нет libsecret / gnome-keyring / KWallet, заблокировано
 * и т.п.). Текст — стабильный маркер: Electron при `invoke` теряет класс и поля
 * ошибки, оставляя только message, по нему renderer и отличает отказ хранилища
 * от ошибки валидации. Текст исходной ошибки не включаем — в нём могут быть пути.
 */
export class SecretStoreUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(SECRET_STORE_UNAVAILABLE, { cause });
    this.name = 'SecretStoreUnavailableError';
  }
}
