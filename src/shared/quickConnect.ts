/**
 * Парсер строки Quick Connect (HM-11): `user@host[:port]`.
 * Переиспользуется main (валидация/подключение) и renderer (live-проверка формы).
 */

/**
 * hostId сессии Быстрого подключения. Строки в `hosts` у неё нет, поэтому все
 * такие сессии — к любым серверам — делят один сентинел: в истории, в
 * контексте сниппетов, в логике переподключения. Это не хост: его нельзя
 * дублировать, переподключить, привязать к нему серверный сниппет или мьют.
 */
export const QUICK_CONNECT_HOST_ID = 0;

export interface ParsedQuickConnect {
  username: string;
  address: string;
  port: number;
}

// Имя пользователя — как в validate.ts USERNAME_RE; адрес — домен/IPv4/IPv6 (в скобках).
const QUICK_CONNECT_RE =
  /^([A-Za-z0-9._-]+)@(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/;

export function parseQuickConnect(input: string): ParsedQuickConnect | null {
  const trimmed = input.trim();
  const m = trimmed.match(QUICK_CONNECT_RE);
  if (!m) return null;

  const username = m[1]!;
  let address = m[2]!;
  if (address.startsWith('[') && address.endsWith(']')) {
    address = address.slice(1, -1);
  }

  const port = m[3] ? Number(m[3]) : 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { username, address, port };
}
