/**
 * Типы автообновления (UPD-01…04). Обновление тянется только с настроенного
 * публичного источника по HTTPS (SEC-07); данные о хостах/сессиях наружу не
 * уходят. Проверка подписи и издателя — в main перед установкой (UPD-03).
 */

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateInfo {
  version: string;
  releaseNotes?: string;
  releaseDate?: string;
}

export interface UpdateProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface UpdateStatus {
  state: UpdateState;
  info?: UpdateInfo;
  progress?: UpdateProgress;
  /** Причина для 'error' — только техническая, без секретов. */
  errorKey?: string;
  /** true, если источник обновлений не настроен (config.updates.source пуст). */
  notConfigured: boolean;
  /** true для сборки без автообновления (Linux .deb): обновляется вручную через Releases. */
  manualOnly: boolean;
  currentVersion: string;
}
