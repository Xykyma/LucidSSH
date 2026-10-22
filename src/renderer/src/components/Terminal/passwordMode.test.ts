import { describe, expect, it } from 'vitest';
import { mayEndPasswordMode } from './passwordMode';

describe('mayEndPasswordMode', () => {
  it('синтетический «на промпте» не выводит из режима пароля', () => {
    expect(mayEndPasswordMode(true, true)).toBe(false);
  });

  it('настоящий маркер выводит из режима пароля', () => {
    expect(mayEndPasswordMode(true, false)).toBe(true);
  });

  it('без запроса пароля синтетический breadcrumb работает как раньше (тикет 18)', () => {
    expect(mayEndPasswordMode(false, true)).toBe(true);
    expect(mayEndPasswordMode(false, false)).toBe(true);
  });
});
