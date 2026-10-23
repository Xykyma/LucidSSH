import { describe, expect, it } from 'vitest';
import { hasControlChars } from './ControlText';

describe('hasControlChars', () => {
  it('находит байты правки строки (Ctrl+A, ESC, DEL)', () => {
    expect(hasControlChars('-rf /tmp/v\x01rm ')).toBe(true);
    expect(hasControlChars('a\x1bb')).toBe(true);
    expect(hasControlChars('a\x7f')).toBe(true);
  });

  it('обычный текст, табы и переводы строк — нет (и повторный вызов не зависит от lastIndex)', () => {
    expect(hasControlChars('ls -la\n\tcd /tmp\r\n')).toBe(false);
    expect(hasControlChars('\x01')).toBe(true);
    expect(hasControlChars('\x01')).toBe(true);
  });
});
