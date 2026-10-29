/** Минимум от BrowserWindow, нужный для показа окна (позволяет тестировать без electron). */
export interface ShowableWindow {
  show(): void;
  isDestroyed(): boolean;
  once(event: 'ready-to-show', cb: () => void): unknown;
}

/**
 * Показывает окно по `ready-to-show`, а если событие не пришло за `timeoutMs`
 * (например, VM без 3D-ускорения) — принудительно по таймеру. Окно показывается
 * не более одного раза.
 */
export function showOnReady(win: ShowableWindow, timeoutMs: number): void {
  let shown = false;
  // timer объявлен ниже, но show вызывается только после его присвоения.
  const show = (): void => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    clearTimeout(timer);
    win.show();
  };
  const timer = setTimeout(show, timeoutMs);
  win.once('ready-to-show', show);
}
