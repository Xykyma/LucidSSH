import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientChannel } from 'ssh2';
import { ShellChannel, type ShellChannelDeps } from './shellChannel';

/**
 * Issue 11 / ADR-0005: панели (ErrorDetector/HintBar), встроенные во flex-
 * раскладку терминала, меняют высоту его контейнера при появлении/скрытии —
 * ResizeObserver в XtermView.tsx реагирует на это реальным PTY-resize
 * (SIGWINCH-эффект), который часть шеллов отвечает перерисовкой приглашения,
 * задваивающей строку в терминале. Гейтинг в ShellChannel.resize не должен
 * измениться без обновления этих тестов.
 *
 * Критерий приёмки (issue 03 спеки, .scratch/shell-channel-extraction/spec.md):
 * ни одного vi.mock, ни одного подключения — только new ShellChannel(...) с
 * фальшивым потоком.
 */

/** Фальшивый поток (ClientChannel) — write/setWindow проверяются напрямую,
 *  data-обработчик доступен для скармливания сырых байтов сервера. */
function fakeStream(): {
  stream: ClientChannel;
  setWindow: ReturnType<typeof vi.fn>;
  feedData: (chunk: string) => void;
} {
  const setWindow = vi.fn();
  const write = vi.fn();
  const dataHandlers: Array<(data: Buffer) => void> = [];
  const stream = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'data') dataHandlers.push(handler as (data: Buffer) => void);
      return stream;
    }),
    stderr: { on: vi.fn() },
    write,
    setWindow
  };
  return {
    stream: stream as unknown as ClientChannel,
    setWindow,
    feedData: (chunk: string) => {
      // Маркер в тестах пишется с nonce из отправленной каналом настройки.
      const sent = write.mock.calls.map((c) => String(c[0])).join('');
      const nonce = /_lucidssh([0-9a-f]+)\\037/.exec(sent)?.[1] ?? '';
      const data = chunk.replaceAll(NONCE_SLOT, nonce);
      for (const handler of dataHandlers) handler(Buffer.from(data, 'utf8'));
    }
  };
}

function fakeDeps(): ShellChannelDeps {
  return {
    onCommandFinished: vi.fn(),
    onUnmarkedOutput: vi.fn(() => false),
    onShellUnavailable: vi.fn(),
    onClosed: vi.fn()
  };
}

function makeChannel(
  cols = 80,
  rows = 24
): {
  channel: ShellChannel;
  setWindow: ReturnType<typeof vi.fn>;
  feedData: (chunk: string) => void;
  deps: ShellChannelDeps;
} {
  const { stream, setWindow, feedData } = fakeStream();
  const deps = fakeDeps();
  const channel = new ShellChannel({ sessionId: 's1', stream, cols, rows, deps });
  return { channel, setWindow, feedData, deps };
}

const US = '\x1f';
/** Место nonce в маркере — feedData подставляет nonce настройки этого канала. */
const NONCE_SLOT = '<nonce>';
/** Тот же формат маркера shell-интеграции, что и в shellIntegrationSession.test.ts. */
const mk = (u: string, h: string, p: string, e: string, c = '0', sudoUser = ''): string =>
  `\x1b_lucidssh${NONCE_SLOT}${US}${u}${US}${h}${US}${e}${US}${c}${US}${sudoUser}${US}${p}${US}${NONCE_SLOT}\x1b\\`;

/** Доводит канал до состояния «первый маркер уже виден» (аналог warmUp() из
 *  shellIntegrationSession.test.ts) — без этого detectInteractiveProgram не
 *  срабатывает (firstMarkSeen должен быть true). Настройка уходит по
 *  реальному таймеру setup-silence (300 мс, shellIntegrationSession.ts) —
 *  продвигаем фальшивые часы вместо доступа к приватному состоянию коробки,
 *  которого у ShellChannel больше нет ни для кого снаружи. */
function warmUp(feedData: (chunk: string) => void): void {
  feedData('Welcome to Ubuntu 24.04\r\n');
  vi.advanceTimersByTime(300);
  feedData(mk('u', 'h', '/home/u', '1000', '0'));
}

describe('ShellChannel — гейтинг PTY-resize по cols (issue 11 / ADR-0005)', () => {
  it('открытие канала не шлёт лишний setWindow — начальный размер уже применён через client.shell()', () => {
    const { setWindow } = makeChannel();
    expect(setWindow).not.toHaveBeenCalled();
  });

  it('изменение только rows (открытие/закрытие ErrorDetector/HintBar) не шлёт реальный PTY-resize', () => {
    const { channel, setWindow } = makeChannel();

    channel.resize(80, 20); // cols те же (80), rows 24 → 20
    expect(setWindow).not.toHaveBeenCalled();

    channel.resize(80, 24); // панель закрылась, rows вернулись к 24
    expect(setWindow).not.toHaveBeenCalled();
  });

  it('изменение cols всегда применяется к PTY, даже если rows тоже изменились', () => {
    const { channel, setWindow } = makeChannel();

    channel.resize(100, 20);
    expect(setWindow).toHaveBeenCalledTimes(1);
    expect(setWindow).toHaveBeenCalledWith(20, 100, 0, 0);
  });

  it('повторный вызов с тем же размером не шлёт лишний resize', () => {
    const { channel, setWindow } = makeChannel();

    channel.resize(100, 24);
    expect(setWindow).toHaveBeenCalledTimes(1);

    channel.resize(100, 24);
    expect(setWindow).toHaveBeenCalledTimes(1);
  });

  describe('с известной интерактивной программой (требует реального таймера setup-silence)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('запуск известной интерактивной программы форсирует досылку ранее пропущенного resize', () => {
      const { channel, setWindow, feedData } = makeChannel();
      warmUp(feedData);
      setWindow.mockClear();

      channel.resize(80, 20); // панель открылась — пропущено (только rows)
      expect(setWindow).not.toHaveBeenCalled();

      channel.sendCommandLine('htop');
      expect(setWindow).toHaveBeenCalledWith(20, 80, 0, 0);
    });

    it('после выхода из программы (breadcrumb) новое изменение rows снова гасится', () => {
      const { channel, setWindow, feedData } = makeChannel();
      warmUp(feedData);

      channel.sendCommandLine('htop');
      setWindow.mockClear();

      // Возврат к промпту после выхода из htop — тот же маркер, что и обычный
      // breadcrumb (BRD-04), снимает interactiveProgramActive.
      feedData(mk('u', 'h', '/home/u', '1000', '0'));

      channel.resize(80, 18);
      expect(setWindow).not.toHaveBeenCalled();
    });
  });
});
