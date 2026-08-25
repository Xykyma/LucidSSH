import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '@shared/config';
import { createDefaultConfig } from './defaults';
import { mergeWithDefaults } from './merge';

/**
 * Хранилище настроек: %APPDATA%\LucidSSH\config.json (§7 ТЗ).
 * Секреты сюда не пишутся никогда (SEC-01). Запись атомарная (tmp + rename),
 * чтобы сбой на середине записи не портил файл.
 */

let cached: AppConfig | null = null;

export function configDir(): string {
  // app.getPath('userData') → %APPDATA%\LucidSSH (productName задаёт имя папки)
  return app.getPath('userData');
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
 * Сброс настроек до заводских (SET-08). НЕ трогает хосты, ключи и историю —
 * они в отдельных хранилищах. Геометрия окна сохраняется, чтобы сброс не был
 * резким (это не «настройка» в смысле SET).
 */
export function resetConfig(): AppConfig {
  const prev = loadConfig();
  const fresh = createDefaultConfig(app.getVersion());
  fresh.window = prev.window;
  cached = fresh;
  saveConfig();
  return fresh;
}
