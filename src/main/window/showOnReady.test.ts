import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showOnReady, type ShowableWindow } from './showOnReady';

const TIMEOUT = 4000;

function fakeWindow(): ShowableWindow & { fireReady: () => void } {
  let ready: (() => void) | undefined;
  return {
    show: vi.fn<() => void>(),
    isDestroyed: () => false,
    once: (_event, cb) => {
      ready = cb;
    },
    fireReady: () => ready?.()
  };
}

describe('showOnReady', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows on ready-to-show and cancels the fallback timer', () => {
    const win = fakeWindow();
    showOnReady(win, TIMEOUT);
    win.fireReady();
    vi.advanceTimersByTime(10_000);
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it('shows by timer when ready-to-show never arrives', () => {
    const win = fakeWindow();
    showOnReady(win, TIMEOUT);
    vi.advanceTimersByTime(TIMEOUT - 1);
    expect(win.show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it('does not show twice when ready-to-show arrives after the timer', () => {
    const win = fakeWindow();
    showOnReady(win, TIMEOUT);
    vi.advanceTimersByTime(TIMEOUT);
    win.fireReady();
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it('does not touch a destroyed window', () => {
    const win = { ...fakeWindow(), isDestroyed: () => true };
    showOnReady(win, TIMEOUT);
    vi.advanceTimersByTime(TIMEOUT);
    expect(win.show).not.toHaveBeenCalled();
  });
});
