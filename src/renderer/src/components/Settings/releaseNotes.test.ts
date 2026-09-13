import { describe, expect, it } from 'vitest';
import { parseReleaseNotes } from './releaseNotes';

/**
 * Разбор release notes GitHub-релиза на секции `## RU` / `## EN` (тема:
 * changelog при обновлении). Технический текст пишется разработчиком вручную
 * при публикации — маркеры регистронезависимы, порядок секций произвольный.
 */

describe('parseReleaseNotes', () => {
  const both = ['## RU', '- Исправлен баг с подключением', '- Ускорен запуск', '', '## EN', '- Fixed connection bug', '- Faster startup'].join('\n');

  it('возвращает пункты нужного языка, когда есть обе секции', () => {
    expect(parseReleaseNotes(both, 'ru')).toEqual(['Исправлен баг с подключением', 'Ускорен запуск']);
    expect(parseReleaseNotes(both, 'en')).toEqual(['Fixed connection bug', 'Faster startup']);
  });

  it('падает обратно на EN, если RU-секции нет', () => {
    const enOnly = ['## EN', '- Fixed connection bug', '- Faster startup'].join('\n');
    expect(parseReleaseNotes(enOnly, 'ru')).toEqual(['Fixed connection bug', 'Faster startup']);
  });

  it('падает обратно на RU, если EN-секции нет', () => {
    const ruOnly = ['## RU', '- Исправлен баг с подключением', '- Ускорен запуск'].join('\n');
    expect(parseReleaseNotes(ruOnly, 'en')).toEqual(['Исправлен баг с подключением', 'Ускорен запуск']);
  });

  it('без маркеров секций возвращает весь текст одним пунктом', () => {
    expect(parseReleaseNotes('Просто текст без секций', 'ru')).toEqual(['Просто текст без секций']);
  });

  it('пустой или отсутствующий текст → пустой список', () => {
    expect(parseReleaseNotes(undefined, 'ru')).toEqual([]);
    expect(parseReleaseNotes('', 'ru')).toEqual([]);
  });

  describe('HTML из atom-ленты GitHub (без releaseNotes в latest.yml)', () => {
    const html = [
      '<p><strong>Приложение распространяется без цифровой подписи.</strong> …</p>',
      '<hr>',
      '<h2>RU</h2>',
      '<ul>',
      '<li><strong>Безопасность:</strong> кнопка «Проверить соединение» …</li>',
      '<li>Страж … (<code>rm -rf /var/www &amp;&amp; rm -rf /etc</code>) …</li>',
      '</ul>',
      '<h2>EN</h2>',
      '<ul>',
      '<li>Security: &quot;Test connection&quot; button …</li>',
      '<li>Guard … (<code>rm -rf /var/www &amp;&amp; rm -rf /etc</code>) …</li>',
      '</ul>',
    ].join('\n');

    it('возвращает пункты нужного языка без тегов, с декодированными сущностями', () => {
      expect(parseReleaseNotes(html, 'ru')).toEqual([
        'Безопасность: кнопка «Проверить соединение» …',
        'Страж … (rm -rf /var/www && rm -rf /etc) …',
      ]);
      expect(parseReleaseNotes(html, 'en')).toEqual([
        'Security: "Test connection" button …',
        'Guard … (rm -rf /var/www && rm -rf /etc) …',
      ]);
    });

    it('падает обратно на другой язык, если в HTML только одна секция', () => {
      const enOnlyHtml = ['<h2>EN</h2>', '<ul>', '<li>Fixed connection bug</li>', '</ul>'].join('\n');
      expect(parseReleaseNotes(enOnlyHtml, 'ru')).toEqual(['Fixed connection bug']);
    });

    it('HTML без <h2>-разделов даёт один пункт без тегов', () => {
      const noSections = '<p><strong>Приложение</strong> без цифровой подписи &amp; SmartScreen.</p>';
      expect(parseReleaseNotes(noSections, 'ru')).toEqual(['Приложение без цифровой подписи & SmartScreen.']);
    });

    it('числовая сущность вне диапазона Unicode остаётся как есть, а не роняет разбор', () => {
      const badEntity = ['<h2>RU</h2>', '<ul>', '<li>a &#x110000; b &#1114112; c</li>', '</ul>'].join('\n');
      expect(parseReleaseNotes(badEntity, 'ru')).toEqual(['a &#x110000; b &#1114112; c']);
    });
  });

  describe('угловые скобки в обычном тексте — не HTML', () => {
    it('markdown с плейсхолдерами <host>/<path> разбирается по секциям, скобки сохраняются', () => {
      const md = ['## RU', '- Подключение: ssh user@<host>', '- Удаление <path> спрашивает имя', '', '## EN', '- Connect: ssh user@<host>'].join('\n');
      expect(parseReleaseNotes(md, 'ru')).toEqual(['Подключение: ssh user@<host>', 'Удаление <path> спрашивает имя']);
      expect(parseReleaseNotes(md, 'en')).toEqual(['Connect: ssh user@<host>']);
    });

    it('текст без секций с <host> возвращается одним пунктом без вырезания', () => {
      expect(parseReleaseNotes('ssh user@<host> теперь работает', 'ru')).toEqual(['ssh user@<host> теперь работает']);
    });
  });
});
