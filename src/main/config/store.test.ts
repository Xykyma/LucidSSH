import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * configDir() = app.getPath('userData') — первый electron-мок в проекте.
 * loadConfig() кэширует результат в module-scope `cached`, поэтому каждый
 * тест переимпортирует модуль свежим через vi.resetModules() (иначе кэш из
 * предыдущего теста утекает между тестами).
 */
let dir = '';
vi.mock('electron', () => ({
  app: {
    getPath: () => dir,
    getVersion: () => '1.2.3-test'
  }
}));

async function freshStore(): Promise<typeof import('./store')> {
  vi.resetModules();
  return import('./store');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucidssh-config-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('нет файла конфига — возвращает дефолты с текущей версией', async () => {
    const { loadConfig } = await freshStore();
    const cfg = loadConfig();
    expect(cfg.version).toBe('1.2.3-test');
    expect(cfg.language).toBe('ru');
    expect(cfg.window.width).toBe(1280);
  });

  it('повреждённый JSON — тихо стартует с дефолтов, не падает', async () => {
    writeFileSync(join(dir, 'config.json'), '{ not valid json', 'utf8');
    const { loadConfig } = await freshStore();
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().language).toBe('ru');
  });

  it('существующий файл — сливается с дефолтами, версия перезаписывается текущей', async () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ version: '0.0.1-old', language: 'en' }),
      'utf8'
    );
    const { loadConfig } = await freshStore();
    const cfg = loadConfig();
    expect(cfg.language).toBe('en');
    expect(cfg.version).toBe('1.2.3-test'); // версия всегда текущая, не из файла
  });

  it('второй вызов возвращает закэшированный объект (не перечитывает файл)', async () => {
    const { loadConfig } = await freshStore();
    const first = loadConfig();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en' }), 'utf8');
    const second = loadConfig();
    expect(second).toBe(first);
    expect(second.language).toBe('ru');
  });
});

describe('saveConfig / updateConfig', () => {
  it('updateConfig — мутирует и сразу пишет на диск (SET-07)', async () => {
    const { loadConfig, updateConfig } = await freshStore();
    loadConfig();
    updateConfig((cfg) => {
      cfg.language = 'en';
    });
    const onDisk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(onDisk.language).toBe('en');
  });

  it('запись атомарная — .tmp файл не остаётся после успешной записи', async () => {
    const { loadConfig, updateConfig } = await freshStore();
    loadConfig();
    updateConfig((cfg) => {
      cfg.language = 'en';
    });
    expect(existsSync(join(dir, 'config.json.tmp'))).toBe(false);
    expect(existsSync(join(dir, 'config.json'))).toBe(true);
  });

  it('saveConfig без предварительного loadConfig — no-op, файл не создаётся', async () => {
    const { saveConfig } = await freshStore();
    saveConfig();
    expect(existsSync(join(dir, 'config.json'))).toBe(false);
  });
});

describe('resetConfig (SET-08)', () => {
  it('сбрасывает настройки, но сохраняет геометрию окна и язык интерфейса (ADR-0014)', async () => {
    const { loadConfig, updateConfig, resetConfig } = await freshStore();
    loadConfig();
    updateConfig((cfg) => {
      cfg.language = 'en'; // Внутреннее состояние — сброс его не трогает
      cfg.window = { width: 999, height: 555, maximized: true };
    });
    const fresh = resetConfig();
    expect(fresh.language).toBe('en');
    expect(fresh.window).toEqual({ width: 999, height: 555, maximized: true });
  });

  it('восстанавливает заводскую карту хоткеев (SET-10) — не трогает хосты/ключи/историю', async () => {
    const { loadConfig, updateConfig, resetConfig } = await freshStore();
    const { DEFAULT_HOTKEYS } = await import('@shared/hotkeys');
    loadConfig();
    updateConfig((cfg) => {
      cfg.hotkeys.openCatalog = 'Ctrl+Alt+P'; // пользователь перепривязал хоткей
    });
    const fresh = resetConfig();
    expect(fresh.hotkeys).toEqual(DEFAULT_HOTKEYS);
  });

  it('не теряет pendingKeyDeployments, geometрию окна и dismissedAlerts дашборда (ADR-0014)', async () => {
    const { loadConfig, updateConfig, resetConfig } = await freshStore();
    loadConfig();
    updateConfig((cfg) => {
      cfg.pendingKeyDeployments = [
        { keyPath: 'C:\\Users\\u\\.ssh\\id_ed25519_web', publicKey: 'ssh-ed25519 AAAA' }
      ];
      cfg.window = { width: 999, height: 555, maximized: true };
      cfg.dashboard.dismissedAlerts[3] = ['cpu'];
    });
    const fresh = resetConfig();
    expect(fresh.pendingKeyDeployments).toEqual([
      { keyPath: 'C:\\Users\\u\\.ssh\\id_ed25519_web', publicKey: 'ssh-ed25519 AAAA' }
    ]);
    expect(fresh.window).toEqual({ width: 999, height: 555, maximized: true });
    expect(fresh.dashboard.dismissedAlerts).toEqual({ 3: ['cpu'] });
  });

  it('возвращает Настройки к дефолтам', async () => {
    const { loadConfig, updateConfig, resetConfig } = await freshStore();
    loadConfig();
    updateConfig((cfg) => {
      cfg.ui.expertMode = true;
      cfg.terminal.fontSize = 20;
      cfg.history.enabled = false;
      cfg.updates.autoCheck = false;
    });
    const fresh = resetConfig();
    expect(fresh.ui.expertMode).toBe(false);
    expect(fresh.terminal.fontSize).toBe(13);
    expect(fresh.history.enabled).toBe(true);
    expect(fresh.updates.autoCheck).toBe(true);
  });
});

describe('projectSettings', () => {
  it('возвращает точный набор ключей Настроек — не протаскивает Внутреннее состояние', async () => {
    const { loadConfig } = await freshStore();
    const { projectSettings } = await import('@shared/config');
    const settings = projectSettings(loadConfig());
    expect(Object.keys(settings).sort()).toEqual(
      ['connection', 'guard', 'history', 'hotkeys', 'shownCounts', 'terminal', 'ui', 'updates'].sort()
    );
    expect(Object.keys(settings.history)).toEqual(['enabled']);
    expect(Object.keys(settings.updates)).toEqual(['autoCheck']);
  });
});
