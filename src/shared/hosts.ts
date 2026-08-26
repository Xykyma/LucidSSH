/**
 * Типы хостов и групп (Data_Structures.md §2).
 * Секретов в этих структурах нет и быть не может (SEC-01).
 */

export type AuthMethod = 'password' | 'key';

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

export interface ImportPreview {
  toAdd: number;
  toSkip: number;
  conflicts: Array<{ name: string; address: string; username: string }>;
  /** Хостов с методом «ключ», чей файл ключа не найден на этом ПК (тикет 03). */
  missingKeyCount: number;
}
