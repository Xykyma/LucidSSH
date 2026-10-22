import { describe, expect, it } from 'vitest';
import { showControlChars } from './guard';

describe('showControlChars', () => {
  it('правка строки видна: Ctrl+A, ESC, DEL, C1 — значками, таб и переводы строки — как есть', () => {
    expect(showControlChars(' -rf ~\x01rm \x1b[H\x7f\u009bx\ty\r\n')).toBe(
      ' -rf ~\u2401rm \u241b[H\u2421\ufffdx\ty\r\n'
    );
  });

  it('обычный текст не трогает', () => {
    expect(showControlChars("cd '/srv/проект' && ls")).toBe("cd '/srv/проект' && ls");
  });
});
