/**
 * Типы хостов и групп (Data_Structures.md §2).
 * Секретов в этих структурах нет и быть не может (SEC-01).
 */

export type AuthMethod = 'password' | 'key';

/** Маркер в `message` ошибки `invoke`: Хранилище секретов отказало (а не ввод невалиден). */
export const SECRET_STORE_UNAVAILABLE = 'SECRET_STORE_UNAVAILABLE';

export interface HostGroup {
  id: number;
  name: string;
  sortOrder: number;
  collapsed: boolean;
  createdAt: string;
}

export interface Host {
  id: number;
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  keyPath?: string; // путь к ОРИГИНАЛЬНОМУ файлу ключа (SEC-02)
  groupId?: number;
  proxyJumpHostId?: number; // ссылка на id другого хоста-bastion (SSH-05)
  note?: string;
  guardEnabled: boolean;
  historyEnabled: boolean; // HIST-07 — запись истории команд для этого хоста
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Форма создания/редактирования. Секрет передаётся ОТДЕЛЬНЫМ аргументом IPC,
 * сразу уходит в keychain и не возвращается в renderer.
 */
export interface HostInput {
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  keyPath?: string;
  groupId?: number;
  proxyJumpHostId?: number;
  note?: string;
  guardEnabled: boolean;
  historyEnabled: boolean;
}

/**
 * UNC- и device-пути (`\\server\share`, `//server`, `\\?\`, `\\.\`): обращение к ним
 * заставляет Windows аутентифицироваться на чужом SMB-сервере (утечка NTLM-хеша).
 * Windows считает любую пару слэшей в начале сетевым путём, в т.ч. смешанную.
 */
export function isNetworkPath(path: string): boolean {
  return /^([\\/]{2}|\\\?\?\\)/.test(path.trim());
}

export interface ImportPreview {
  toAdd: number;
  toSkip: number;
  conflicts: Array<{ name: string; address: string; username: string }>;
  /** Хостов с методом «ключ», чей файл ключа не найден на этом ПК (тикет 03). */
  missingKeyCount: number;
  /** Записей с недопустимым путём к ключу (UNC/device) — не импортируются. */
  invalidCount: number;
}
