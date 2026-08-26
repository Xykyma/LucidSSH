import { describe, expect, it } from 'vitest';
import { mergeWithDefaults } from './merge';

const defaults = {
  version: '1.0.0',
  language: 'ru',
  window: { width: 1280, height: 800, maximized: false },
  history: { enabled: true },
  shownCounts: {} as Record<string, number>,
  pendingKeyDeployments: [] as Array<{ keyPath: string; publicKey: string }>,
  hotkeys: { quickConnect: 'Ctrl+K', openCatalog: 'Ctrl+Shift+L' }
};

describe('mergeWithDefaults', () => {
  it('возвращает дефолты для повреждённого файла', () => {
    expect(mergeWithDefaults(defaults, null)).toEqual(defaults);
    expect(mergeWithDefaults(defaults, 'garbage')).toEqual(defaults);
    expect(mergeWithDefaults(defaults, [1, 2])).toEqual(defaults);
  });

  it('накладывает сохранённые значения на дефолты', () => {
    const merged = mergeWithDefaults(defaults, {
      language: 'en',
      window: { width: 900, maximized: true }
    });
    expect(merged.language).toBe('en');
    expect(merged.window).toEqual({ width: 900, height: 800, maximized: true });
  });

  it('отбрасывает неизвестные ключи', () => {
    const merged = mergeWithDefaults(defaults, { evil: 'x', language: 'en' });
    expect('evil' in merged).toBe(false);
  });

  it('заменяет значения с неверным типом дефолтом', () => {
    const merged = mergeWithDefaults(defaults, {
      language: 42,
      window: { width: 'wide' },
      history: { enabled: 'yes' }
    });
    expect(merged.language).toBe('ru');
    expect(merged.window.width).toBe(1280);
    expect(merged.history.enabled).toBe(true);
  });

  it('в shownCounts принимает только числовые значения', () => {
    const merged = mergeWithDefaults(defaults, {
      shownCounts: { hintA: 2, hintB: 'many', hintC: Infinity }
    });
    expect(merged.shownCounts).toEqual({ hintA: 2 });
  });

  it('в pendingKeyDeployments отбрасывает элементы неверной формы по одному (HM-12)', () => {
    const valid = { keyPath: 'C:\\Users\\u\\.ssh\\id_ed25519_web', publicKey: 'ssh-ed25519 AAAA' };
    const merged = mergeWithDefaults(defaults, {
      pendingKeyDeployments: [valid, { keyPath: 'x' }, 'garbage', null, 42]
    });
    expect(merged.pendingKeyDeployments).toEqual([valid]);
  });

  it('pendingKeyDeployments игнорируется целиком, если сохранённое значение не массив', () => {
    const merged = mergeWithDefaults(defaults, { pendingKeyDeployments: 'garbage' });
    expect(merged.pendingKeyDeployments).toEqual([]);
  });

  it('hotkeys (SET-10): без сохранённых оверрайдов — заводские значения по всем действиям', () => {
    const merged = mergeWithDefaults(defaults, {});
    expect(merged.hotkeys).toEqual(defaults.hotkeys);
  });

  it('hotkeys: сохранённый оверрайд одного действия не трогает остальные', () => {
    const merged = mergeWithDefaults(defaults, { hotkeys: { openCatalog: 'Ctrl+Alt+L' } });
    expect(merged.hotkeys).toEqual({ quickConnect: 'Ctrl+K', openCatalog: 'Ctrl+Alt+L' });
  });
});
