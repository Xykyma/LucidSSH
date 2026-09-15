import type {
  GuardStatus,
  HistoryEntry,
  HistoryQuery,
  HistoryRecordInput
} from '@shared/history';
import { openHistoryDb } from './db';
import { maskSecrets } from '../secrets/maskers';

/**
 * Репозиторий истории (HIST-01…07). Команда маскируется ПЕРЕД записью (HIST-07);
 * замаскированное значение нигде не восстанавливается. FIFO-лимит 10 000 (HIST-06).
 */

const FIFO_LIMIT = 10_000;
// Лимит на сохранённый вывод команды (разворачивание в HistoryDrawer, Ideas_Backlog.md
// «Разворачивание вывода по клику»). Длинный вывод усекается, флаг — outputTruncated.
const OUTPUT_LIMIT = 4000;

interface HistoryRow {
  id: number;
  command: string;
  host_id: number | null;
  host_name: string;
  username: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  guard_status: string | null;
  has_secret: number;
  note: string | null;
  output: string | null;
  output_truncated: number;
  snip_id: number | null;
  snip_name: string | null;
  snip_host_id: number | null;
}

function rowToEntry(r: HistoryRow): HistoryEntry {
  return {
    id: r.id,
    command: r.command,
    hostId: r.host_id ?? undefined,
    hostName: r.host_name,
    username: r.username,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? undefined,
    exitCode: r.exit_code ?? undefined,
    guardStatus: (r.guard_status as GuardStatus | null) ?? undefined,
    hasSecret: r.has_secret === 1,
    note: r.note ?? undefined,
    output: r.output ?? undefined,
    outputTruncated: r.output_truncated === 1,
    snippet:
      r.snip_id != null
        ? { id: r.snip_id, name: r.snip_name!, hostId: r.snip_host_id ?? undefined }
        : undefined
  };
}

/**
 * Готовит вывод команды к сохранению (HIST-07): маскирует теми же правилами,
 * что и команду, и усекает до OUTPUT_LIMIT. Если сама команда уже содержала
 * секрет (commandHasSecret) — вывод не сохраняется вовсе (двойная защита:
 * например `export API_KEY=...; env` — секрет мог утечь в echo вывода тоже).
 */
export function prepareOutput(
  raw: string | undefined,
  commandHasSecret: boolean
): { output: string | null; outputTruncated: boolean; outputHasSecret: boolean } {
  if (!raw || commandHasSecret) return { output: null, outputTruncated: false, outputHasSecret: false };
  const { masked, hasSecret } = maskSecrets(raw);
  const truncated = masked.length > OUTPUT_LIMIT;
  return {
    output: truncated ? masked.slice(0, OUTPUT_LIMIT) : masked,
    outputTruncated: truncated,
    outputHasSecret: hasSecret
  };
}

/** Записать команду. Возвращает id и признак наличия секрета (для бейджа). */
export function recordHistory(input: HistoryRecordInput): { id: number; hasSecret: boolean } {
  const commandMask = maskSecrets(input.command); // HIST-07
  const { output, outputTruncated, outputHasSecret } = prepareOutput(
    input.output,
    commandMask.hasSecret
  );
  const hasSecret = commandMask.hasSecret || outputHasSecret;
  const now = new Date().toISOString();
  const db = openHistoryDb();
  const res = db
    .prepare(
      `INSERT INTO history (command, host_id, host_name, username, started_at, finished_at,
         exit_code, guard_status, has_secret, note, output, output_truncated)
       VALUES (@command, @hostId, @hostName, @username, @startedAt, @finishedAt,
         @exitCode, @guardStatus, @hasSecret, NULL, @output, @outputTruncated)`
    )
    .run({
      command: commandMask.masked,
      hostId: input.hostId ?? null,
      hostName: input.hostName,
      username: input.username,
      startedAt: now,
      finishedAt: now,
      exitCode: input.exitCode ?? null,
      guardStatus: input.guardStatus ?? null,
      hasSecret: hasSecret ? 1 : 0,
      output,
      outputTruncated: outputTruncated ? 1 : 0
    });

  // FIFO: при превышении лимита удаляем старейшие, кроме избранных (HIST-06, §3.4)
  const count = db.prepare('SELECT COUNT(*) c FROM history').get() as { c: number };
  if (count.c > FIFO_LIMIT) {
    db.prepare(
      `DELETE FROM history WHERE id IN (
         SELECT id FROM history WHERE is_favorite = 0 ORDER BY started_at ASC LIMIT ?
       )`
    ).run(count.c - FIFO_LIMIT);
  }
  return { id: Number(res.lastInsertRowid), hasSecret };
}

/**
 * Пометка «сохранена как сниппет» (SNIP-12, решение 10 spec.md): скалярные
 * подзапросы — серверный сниппет ЭТОЙ строки (её host_id) и глобальный,
 * COALESCE отдаёт серверный первым. Правило «тот же сниппет» остаётся в
 * одном месте с SNIP-11 (findDuplicateSnippet), без второй копии в renderer.
 * h.host_id IS NULL (Быстрое подключение/без хоста) не матчит host_id
 * подзапроса srv по равенству (NULL = NULL не true в SQL) — совпадают только
 * глобальные, как и требует решение 2.
 *
 * Скалярные подзапросы, а не LEFT JOIN: findDuplicateSnippet — только
 * предупреждение при сохранении (SNIP-11), не блокирует его, и в `snippets`
 * нет UNIQUE(command, host_id) — два сниппета с одинаковой командой в одном
 * скоупе физически возможны. LEFT JOIN на дубликат размножил бы строку
 * history (по одной на каждое совпадение); `ORDER BY id LIMIT 1` в подзапросе
 * гарантирует не больше одного совпадения на сторону независимо от этого.
 */
export function listHistory(query?: HistoryQuery): HistoryEntry[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (query?.text) {
    // Поиск по команде и заметке (HIST-03). Секрет замаскирован → не всплывёт.
    clauses.push("(h.command LIKE @text OR IFNULL(h.note, '') LIKE @text)");
    params['text'] = `%${query.text}%`;
  }
  if (query?.hostId !== undefined) {
    clauses.push('h.host_id = @hostId');
    params['hostId'] = query.hostId;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = openHistoryDb()
    .prepare(
      `SELECT h.*,
              COALESCE(
                (SELECT id FROM snippets WHERE command = h.command AND host_id = h.host_id ORDER BY id LIMIT 1),
                (SELECT id FROM snippets WHERE command = h.command AND host_id IS NULL ORDER BY id LIMIT 1)
              ) AS snip_id,
              COALESCE(
                (SELECT name FROM snippets WHERE command = h.command AND host_id = h.host_id ORDER BY id LIMIT 1),
                (SELECT name FROM snippets WHERE command = h.command AND host_id IS NULL ORDER BY id LIMIT 1)
              ) AS snip_name,
              (SELECT host_id FROM snippets WHERE command = h.command AND host_id = h.host_id ORDER BY id LIMIT 1) AS snip_host_id
       FROM history h
       ${where}
       ORDER BY h.started_at DESC LIMIT 2000`
    )
    .all(params) as HistoryRow[];
  return rows.map(rowToEntry);
}

export function totalHistoryCount(): number {
  return (openHistoryDb().prepare('SELECT COUNT(*) c FROM history').get() as { c: number }).c;
}

export function addHistoryNote(id: number, note: string): void {
  openHistoryDb().prepare('UPDATE history SET note = ? WHERE id = ?').run(note, id);
}

export function deleteHistoryEntry(id: number): void {
  openHistoryDb().prepare('DELETE FROM history WHERE id = ?').run(id);
}

export function clearHistory(): void {
  openHistoryDb().prepare('DELETE FROM history').run();
}

/** Число записей одного хоста (HIST-08) — не зависит от текстового поиска. */
export function historyCountForHost(hostId: number): number {
  return (
    openHistoryDb()
      .prepare('SELECT COUNT(*) c FROM history WHERE host_id = ?')
      .get(hostId) as { c: number }
  ).c;
}

/** Очистить историю только одного хоста, не трогая записи остальных (HIST-08). */
export function clearHistoryForHost(hostId: number): void {
  openHistoryDb().prepare('DELETE FROM history WHERE host_id = ?').run(hostId);
}

/**
 * Хосты, встречающиеся в истории (таблетки фильтра, HIST-08) — по ВСЕЙ
 * таблице, а не по странице listHistory (LIMIT 2000): иначе хост, чьи строки
 * все старше последних 2000, таблетки не получает вовсе. Имя — из самой
 * свежей строки этого хоста (id как тай-брейк для started_at).
 * Признак «удалён» (сверка с hosts.db) — на стороне ipc/history.ts: отдельная
 * БД, JOIN невозможен.
 */
export function listHistoryHosts(): { hostId: number; hostName: string }[] {
  const rows = openHistoryDb()
    .prepare(
      `SELECT host_id, host_name FROM history
       WHERE host_id IS NOT NULL AND id IN (
         SELECT MAX(id) FROM history WHERE host_id IS NOT NULL GROUP BY host_id
       )`
    )
    .all() as { host_id: number; host_name: string }[];
  return rows.map((r) => ({ hostId: r.host_id, hostName: r.host_name }));
}
