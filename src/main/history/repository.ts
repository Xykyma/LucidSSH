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
    outputTruncated: r.output_truncated === 1
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

export function listHistory(query?: HistoryQuery): HistoryEntry[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (query?.text) {
    // Поиск по команде и заметке (HIST-03). Секрет замаскирован → не всплывёт.
    clauses.push("(command LIKE @text OR IFNULL(note, '') LIKE @text)");
    params['text'] = `%${query.text}%`;
  }
  if (query?.hostId !== undefined) {
    clauses.push('host_id = @hostId');
    params['hostId'] = query.hostId;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = openHistoryDb()
    .prepare(`SELECT * FROM history ${where} ORDER BY started_at DESC LIMIT 2000`)
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
