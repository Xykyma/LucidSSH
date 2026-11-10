import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { combineConfig, projectState, type AppConfig } from '@shared/config';
import { createDefaultConfig } from './defaults';
import { mergeWithDefaults } from './merge';

/**
 * Хранилище настроек: config.json в каталоге профиля (§7 ТЗ). У установленной
 * версии и в dev это %APPDATA%\LucidSSH; у portable-сборки — папка исходного exe
 * (см. configDir). Секреты сюда не пишутся никогда (SEC-01). Запись атомарная
 * (tmp + rename), чтобы сбой на середине записи не портил файл.
 */

let cached: AppConfig | null = null;

/**
 * Единая точка выбора каталога профиля (NFR-05): отсюда берут путь настройки,
 * обе БД, known_hosts и резервные копии. Режимом владеет запущенный артефакт:
 * electron-builder задаёт PORTABLE_EXECUTABLE_DIR только упакованной Windows
 * portable-сборке, поэтому dev, неупакованное приложение и другие платформы
 * переменную игнорируют и держат прежний системный каталог. Системный каталог
 * Electron (кэши Chromium и пр.) глобально не перенаправляется.
 */
export function configDir(): string {
  if (isPortableBuild()) {
    return process.env.PORTABLE_EXECUTABLE_DIR!;
  }
  // app.getPath('userData') → %APPDATA%\LucidSSH (productName задаёт имя папки)
  return app.getPath('userData');
}

/** Режимом владеет запущенный артефакт (см. configDir). */
export function isPortableBuild(): boolean {
  return app.isPackaged && process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_DIR;
}

function configPath(): string {
  return join(configDir(), 'config.json');
}

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const defaults = createDefaultConfig(app.getVersion());
  try {
    const raw = readFileSync(configPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    cached = mergeWithDefaults(defaults, parsed);
    cached.version = app.getVersion();
  } catch {
    // нет файла или он повреждён — стартуем с дефолтов
    cached = defaults;
  }
  return cached;
}

export function saveConfig(): void {
  if (!cached) return;
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const target = configPath();
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(cached, null, 2), 'utf8');
  renameSync(tmp, target);
}

/** Точечное обновление настроек c немедленной записью (SET-07). */
export function updateConfig(mutator: (cfg: AppConfig) => void): AppConfig {
  const cfg = loadConfig();
  mutator(cfg);
  saveConfig();
  return cfg;
}

/**
 * Сброс настроек до заводских (SET-08). Правило, а не список исключений:
 * `Settings` заменяется дефолтной, `AppState` (window, язык, ожидающие
 * дозаписи ключей, dismissedAlerts дашборда…) переносится из прежнего
 * конфига целиком — этим полям не принадлежит фабричный сброс, ими владеет
 * main, а не пользовательская настройка. НЕ трогает хосты, ключи и историю
 * в БД — они в отдельных хранилищах.
 */
export function resetConfig(): AppConfig {
  const prev = loadConfig();
  const fresh = createDefaultConfig(app.getVersion());
  const next = combineConfig(fresh, projectState(prev));
  cached = next;
  saveConfig();
  return next;
}
