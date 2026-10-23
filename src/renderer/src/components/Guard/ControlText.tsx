import type { JSX } from 'react';
import { EDIT_CONTROL_CHARS, showControlChars } from '@shared/guard';

// Тот же набор, что у Стража и showControlChars; скобки — чтобы split оставил совпадения.
const SPLIT_RE = new RegExp(`(${EDIT_CONTROL_CHARS.source})`);

/** Есть ли в тексте управляющие байты правки строки (тикет 28: предупреждение в предпросмотре). */
export function hasControlChars(text: string): boolean {
  return new RegExp(EDIT_CONTROL_CHARS.source).test(text);
}

/**
 * Текст для показа с видимыми управляющими байтами (тикет 23) — каждый байт в
 * контрастном чипе: значок ␁ при размере соседних символов читался как пятно
 * (тикет 28). Отправляется всегда исходный текст.
 */
export function ControlText({ text }: { text: string }): JSX.Element {
  return (
    <>
      {text.split(SPLIT_RE).map((part, i) =>
        // split с одной группой: нечётные элементы — совпадения
        i % 2 === 1 ? (
          <span
            key={i}
            className="mx-px rounded-[3px] bg-warning/25 px-[3px] text-[1.3em] leading-none font-bold text-warning-text"
          >
            {showControlChars(part)}
          </span>
        ) : (
          part
        )
      )}
    </>
  );
}
