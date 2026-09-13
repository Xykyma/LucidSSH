/**
 * Разбор release notes GitHub-релиза (electron-updater `info.releaseNotes`)
 * на секции RU / EN — формат зафиксирован в Release_and_Update_Strategy.md
 * §6.1 (обязателен для release notes каждого релиза начиная с этой темы,
 * «changelog при обновлении»).
 *
 * Два формата на входе:
 * - markdown (`## RU` / `- пункт`) — когда `latest.yml` собран с полем
 *   `releaseNotes` (тикет `01`);
 * - HTML (`<h2>RU</h2>` / `<li>пункт</li>`) — когда поля нет и
 *   electron-updater берёт `info.releaseNotes` из atom-ленты GitHub, где
 *   описание Release уже отрендерено в HTML.
 *
 * Без markdown-библиотеки и без DOM/innerHTML (текст недоверенный — TERM-07,
 * SEC-08; тесты идут в `environment: 'node'`, где нет DOMParser) — только
 * построчный разбор списков и регулярки по конкретным тегам, которые
 * генерирует GitHub.
 */

const MARKDOWN_SECTION_HEADER = /^##\s*(ru|en)\s*$/i;
const HTML_SECTION_HEADER = /<h2[^>]*>\s*(ru|en)\s*<\/h2>/gi;
const HTML_LIST_ITEM = /<li[^>]*>([\s\S]*?)<\/li>/gi;

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

/** Декодирует HTML-сущности: именованные (`&amp;` …) и числовые (`&#39;`, `&#x27;`). */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Снимает HTML-теги и декодирует сущности — только для текста, который генерирует GitHub. */
function stripHtml(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, '')).trim();
}

function parseMarkdown(text: string): Map<'ru' | 'en', string[]> {
  const sections = new Map<'ru' | 'en', string[]>();
  let current: 'ru' | 'en' | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const header = MARKDOWN_SECTION_HEADER.exec(line);
    if (header) {
      current = header[1]!.toLowerCase() as 'ru' | 'en';
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current && line) sections.get(current)!.push(line.replace(/^[-*]\s*/, ''));
  }

  return sections;
}

function parseHtml(text: string): Map<'ru' | 'en', string[]> {
  const sections = new Map<'ru' | 'en', string[]>();

  const headers = [...text.matchAll(HTML_SECTION_HEADER)];
  for (let i = 0; i < headers.length; i++) {
    const lang = headers[i]![1]!.toLowerCase() as 'ru' | 'en';
    const start = headers[i]!.index! + headers[i]![0].length;
    const end = i + 1 < headers.length ? headers[i + 1]!.index! : text.length;
    const body = text.slice(start, end);

    const items: string[] = [];
    for (const item of body.matchAll(HTML_LIST_ITEM)) {
      items.push(stripHtml(item[1]!));
    }
    if (!sections.has(lang)) sections.set(lang, []);
    sections.get(lang)!.push(...items);
  }

  return sections;
}

/** Возвращает пункты изменений для языка `lang`, с фолбэком на другой язык. */
export function parseReleaseNotes(text: string | undefined, lang: 'ru' | 'en'): string[] {
  if (!text || !text.trim()) return [];

  const isHtml = /<[a-z][^>]*>/i.test(text);
  const sections = isHtml ? parseHtml(text) : parseMarkdown(text);

  if (sections.size === 0) return [isHtml ? stripHtml(text) : text.trim()];

  const target = sections.get(lang) ?? sections.get(lang === 'ru' ? 'en' : 'ru') ?? [];
  return target;
}
