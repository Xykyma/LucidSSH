import { useEffect, useState } from 'react';

/**
 * Версия приложения из `getAppInfo()` (main: `app.getVersion()`). Не часть
 * `AppConfig` (см. `.scratch/config-settings-state-split/spec.md` PR-1) —
 * читается отдельным IPC-каналом, кешируемым здесь на время жизни компонента.
 * Пустая строка до резолва промиса — вызывающий сам решает, чем её показать
 * (обычно '—').
 */
export function useAppVersion(): string {
  const [version, setVersion] = useState('');

  useEffect(() => {
    void window.lucidSSH.getAppInfo().then((info) => setVersion(info.version));
  }, []);

  return version;
}
