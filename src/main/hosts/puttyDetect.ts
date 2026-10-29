import { execFile } from 'node:child_process';

/**
 * Детекция сессий PuTTY в реестре (для OB-01: кнопка «Импортировать из PuTTY»
 * показывается только при наличии сессий). Сам импорт — Этап 8 (HM-03).
 * Команда статическая, пользовательский ввод не подставляется (§19 гайда).
 */

const PUTTY_SESSIONS_KEY = 'HKCU\\Software\\SimonTatham\\PuTTY\\Sessions';
// reg.exe принимает сокращённый куст (HKCU) как ВХОД, но в ВЫВОДЕ всегда
// печатает полное имя (HKEY_CURRENT_USER) — сверка с сокращённым префиксом
// никогда не совпадала, счётчик всегда был 0 (см. puttyImport.ts:25, там
// сделано верно).
const OUTPUT_KEY_PREFIX = 'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\';

export function countPuttySessions(): Promise<number> {
  // В WSL reg.exe находится через PATH Windows и отдаёт чужой реестр.
  if (process.platform !== 'win32') return Promise.resolve(0);
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', PUTTY_SESSIONS_KEY],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(0); // ключа нет или reg недоступен — PuTTY-сессий нет
          return;
        }
        const count = stdout
          .split(/\r?\n/)
          .filter((line) => line.trim().startsWith(OUTPUT_KEY_PREFIX)).length;
        resolve(count);
      }
    );
  });
}
