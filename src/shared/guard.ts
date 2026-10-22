/**
 * Типы Стража для IPC (Data_Structures.md §7.1).
 */

/** Управляющие символы C0 (кроме табуляции и переводов строки), DEL и C1 —
 *  байты, которыми readline правит строку. Один набор на обе стороны: Страж
 *  в main анализирует по нему сырой ввод, renderer по нему же делает байты
 *  видимыми (showControlChars) — показанное не расходится с проверенным. */
// eslint-disable-next-line no-control-regex
export const EDIT_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/**
 * Только для показа (предпросмотр вставки, модалка Стража): управляющие байты
 * правки строки становятся видимыми значками ␁ ␛ ␡, C1 — �. Иначе ` -rf ~`,
 * Ctrl+A, `rm ` показывается как `-rf ~rm `, и непонятно, почему сработал Страж
 * (тикет 23). Таб и переводы строки не трогаются; отправляется всегда исходный текст.
 */
export function showControlChars(text: string): string {
  return text.replace(EDIT_CONTROL_CHARS, (c) => {
    const code = c.charCodeAt(0);
    if (code < 0x20) return String.fromCharCode(0x2400 + code);
    return code === 0x7f ? '\u2421' : '\ufffd';
  });
}

export type DangerScope = 'file' | 'directory' | 'disk' | 'other';

/** id опасного паттерна (guard/patterns.ts, GUARD-01) — для i18n-объяснения
 *  (guard.explain.<id>) и сравнений в renderer. Закрытый юнион: новый паттерн
 *  без добавления сюда не пройдёт компиляцию (см. PATTERNS в patterns.ts).
 *  'edited-input' — не паттерн, его ставит guard/manager.ts сырому куску с
 *  правкой строки, которая выполнится (тикет 23). */
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
  | 'kill-init'
  | 'edited-input';

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
