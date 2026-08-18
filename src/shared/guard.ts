/**
 * Типы Стража для IPC (Data_Structures.md §7.1).
 */

export type DangerScope = 'file' | 'directory' | 'disk' | 'other';

/** id опасного паттерна (guard/patterns.ts, GUARD-01) — для i18n-объяснения
 *  (guard.explain.<id>) и сравнений в renderer. Закрытый юнион: новый паттерн
 *  без добавления сюда не пройдёт компиляцию (см. PATTERNS в patterns.ts). */
export type DangerPatternId =
  | 'rm-recursive'
  | 'dd-write'
  | 'mkfs'
  | 'chmod-777'
  | 'truncate'
  | 'redirect-device'
  | 'shred'
  | 'wipefs'
  | 'fork-bomb'
  | 'drop-database'
  | 'kill-init';

export interface DangerousCommandPrompt {
  requestId: string;
  sessionId: string;
  command: string;
  /** Паттерн ВЫБРАННОГО объекта — объяснение описывает именно его. */
  patternId: DangerPatternId;
  /** Объект, имя которого нужно набрать (GUARD-03). При нескольких опасных
   *  фрагментах выбран жребием среди самых тяжёлых — см.
   *  .scratch/guard-multi-fragment-confirm/spec.md. */
  target: string;
  /** ВСЕ распознанные объекты строки — для показа: сначала совпадение по всей
   *  строке (форк-бомба), затем по фрагментам, в порядке фрагментов. Всегда
   *  содержит target; при одном опасном фрагменте — ровно его. */
  targets: string[];
  scope: DangerScope;
  /** 'target' — подтверждение именем объекта, 'word' — общим словом подтверждения. */
  confirmationKind: 'target' | 'word';
  /** Текст, который нужно ввести для подтверждения (уже локализован). */
  confirmationText: string;
}

/** Категория риска потери SSH-доступа (GUARD-07). */
export type AccessRiskId = 'sshd-config' | 'firewall' | 'passwd' | 'sshd-service';

/**
 * Предупреждение о риске потери SSH-доступа (GUARD-07): не блокировка, а
 * рекомендация — модалка с двумя кнопками, без type-to-confirm.
 */
export interface AccessRiskPrompt {
  requestId: string;
  sessionId: string;
  command: string;
  riskId: AccessRiskId;
}

/** Результат отправки команды через Стража. */
export type SubmitResult =
  | { status: 'sent' }
  | { status: 'blocked'; prompt: DangerousCommandPrompt }
  | { status: 'access-risk'; prompt: AccessRiskPrompt };
