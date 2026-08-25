import type { JSX, ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Settings, UpdateHotkeyResult } from '@shared/config';
import type { HotkeyAction } from '@shared/hotkeys';

/**
 * Стор настроек: кэш config.json + точечное обновление (SET-07 пишет немедленно).
 * Модульная копия `currentConfig` нужна коду вне React (создание xterm), который
 * читает актуальные настройки терминала синхронно.
 */

let currentConfig: Settings | null = null;
export function getCurrentConfig(): Settings | null {
  return currentConfig;
}

interface ConfigStore {
  config: Settings | null;
  update: (path: string, value: string | number | boolean) => Promise<void>;
  /** SET-10: перепривязка хоткея с проверкой конфликтов (issue #1). При
   *  конфликте состояние стора не меняется — возвращает, кто уже владеет
   *  комбинацией, чтобы секция «Горячие клавиши» показала сообщение. */
  updateHotkey: (action: HotkeyAction, combo: string) => Promise<UpdateHotkeyResult>;
  /** «Сбросить хоткеи к заводским» — только карта хоткеев, остальные настройки
   *  не трогает (в отличие от общего сброса SET-08 внизу Настроек). */
  resetHotkeys: () => Promise<void>;
  /** Отметить показ одноразовой подсказки (§5.1, SNIP-08). */
  markHint: (hintId: string) => Promise<void>;
  /** «Сбросить счётчик показов подсказок» (Настройки → Интерфейс). */
  resetHints: () => Promise<void>;
}

const Ctx = createContext<ConfigStore | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }): JSX.Element {
  const [config, setConfig] = useState<Settings | null>(currentConfig);

  useEffect(() => {
    void window.lucidSSH.getConfig().then((c) => {
      currentConfig = c;
      setConfig(c);
    });
  }, []);

  const update = useCallback(async (path: string, value: string | number | boolean) => {
    const next = await window.lucidSSH.updateConfig(path, value);
    currentConfig = next;
    setConfig(next);
  }, []);

  const updateHotkey = useCallback(async (action: HotkeyAction, combo: string) => {
    const result = await window.lucidSSH.updateHotkey(action, combo);
    if (result.ok) {
      currentConfig = result.config;
      setConfig(result.config);
    }
    return result;
  }, []);

  const resetHotkeys = useCallback(async () => {
    const next = await window.lucidSSH.resetHotkeys();
    currentConfig = next;
    setConfig(next);
  }, []);

  const markHint = useCallback(async (hintId: string) => {
    const next = await window.lucidSSH.markHint(hintId);
    currentConfig = next;
    setConfig(next);
  }, []);

  const resetHints = useCallback(async () => {
    const next = await window.lucidSSH.resetHintCounters();
    currentConfig = next;
    setConfig(next);
  }, []);

  const value = useMemo<ConfigStore>(
    () => ({ config, update, updateHotkey, resetHotkeys, markHint, resetHints }),
    [config, update, updateHotkey, resetHotkeys, markHint, resetHints]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useConfig(): ConfigStore {
  const store = useContext(Ctx);
  if (!store) throw new Error('useConfig outside ConfigProvider');
  return store;
}
