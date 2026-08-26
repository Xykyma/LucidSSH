import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc';
import type { HistoryEntry, HistoryQuery, Snippet } from '@shared/history';
import {
  addHistoryNote,
  clearHistory,
  clearHistoryForHost,
  deleteHistoryEntry,
  historyCountForHost,
  listHistory,
  totalHistoryCount
} from '../history/repository';
import {
  createSnippet,
  deleteSnippet,
  findDuplicateSnippet,
  getSnippet,
  hostHasSnippets,
  listSnippets,
  reorderSnippets,
  resolveHostSnippets,
  updateSnippet
} from '../history/snippets';
import { assertSenderIsMainWindow, IpcValidationError } from './validate';
import { validateId, validateOptionalHostId } from '../hosts/validate';

/**
 * IPC истории и сниппетов (HIST-01…07, SNIP-01…08). Все аргументы валидируются
 * в main. Секреты в командах уже замаскированы на уровне записи (HIST-07).
 */

/**
 * hostId для операций над историей допускает 0 — сентинел Быстрого подключения
 * (HM-11), у которого нет строки в `hosts`, но есть свои записи в `history`
 * (host_id=0). В отличие от validateId (>=1) здесь 0 — валидный, реальный
 * хост для очистки/подсчёта, а не «контекст не задан», как в
 * validateOptionalHostId (снипеты).
 */
export function validateHistoryHostId(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new IpcValidationError('hostId: non-negative integer expected');
  }
  return v;
}

function str(v: unknown, name: string, maxLen: number, required = true): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw new IpcValidationError(`${name}: required`);
    return undefined;
  }
  if (typeof v !== 'string' || v.length > maxLen) throw new IpcValidationError(`${name}: invalid`);
  return v;
}

export function registerHistoryIpcHandlers(): void {
  // --- История ---
  ipcMain.handle(IPC.historyList, (event, rawQuery: unknown): HistoryEntry[] => {
    assertSenderIsMainWindow(event);
    const query: HistoryQuery = {};
    if (typeof rawQuery === 'object' && rawQuery !== null) {
      const q = rawQuery as Record<string, unknown>;
      if (typeof q['text'] === 'string' && q['text'].length <= 200) query.text = q['text'];
      if (typeof q['hostId'] === 'number' && Number.isInteger(q['hostId'])) query.hostId = q['hostId'];
    }
    return listHistory(query);
  });

  ipcMain.handle(IPC.historyCount, (event): number => {
    assertSenderIsMainWindow(event);
    return totalHistoryCount();
  });

  ipcMain.handle(IPC.historyAddNote, (event, rawId: unknown, rawNote: unknown): void => {
    assertSenderIsMainWindow(event);
    const id = validateId(rawId, 'historyId');
    const note = str(rawNote, 'note', 2000, false) ?? '';
    addHistoryNote(id, note);
  });

  ipcMain.handle(IPC.historyDelete, (event, rawId: unknown): void => {
    assertSenderIsMainWindow(event);
    deleteHistoryEntry(validateId(rawId, 'historyId'));
  });

  ipcMain.handle(IPC.historyClear, (event): void => {
    assertSenderIsMainWindow(event);
    clearHistory();
  });

  ipcMain.handle(IPC.historyCountForHost, (event, rawHostId: unknown): number => {
    assertSenderIsMainWindow(event);
    return historyCountForHost(validateHistoryHostId(rawHostId));
  });

  ipcMain.handle(IPC.historyClearForHost, (event, rawHostId: unknown): void => {
    assertSenderIsMainWindow(event);
    clearHistoryForHost(validateHistoryHostId(rawHostId));
  });

  // --- Сниппеты ---
  ipcMain.handle(IPC.snippetsList, (event, rawHostId: unknown): Snippet[] => {
    assertSenderIsMainWindow(event);
    // hostId=0 — сентинел Быстрого подключения (HM-11): хоста нет, значит
    // только глобальные сниппеты (SNIP-06), а не ошибка валидации.
    return listSnippets(validateOptionalHostId(rawHostId));
  });

  ipcMain.handle(IPC.snippetCreate, (event, raw: unknown): { id: number } => {
    assertSenderIsMainWindow(event);
    const input = validateSnippetInput(raw);
    return createSnippet(input);
  });

  ipcMain.handle(IPC.snippetUpdate, (event, rawId: unknown, raw: unknown): void => {
    assertSenderIsMainWindow(event);
    const id = validateId(rawId, 'snippetId');
    if (typeof raw !== 'object' || raw === null) throw new IpcValidationError('input: object');
    const r = raw as Record<string, unknown>;
    updateSnippet(id, {
      name: str(r['name'], 'name', 100, false),
      command: str(r['command'], 'command', 10000, false),
      description: str(r['description'], 'description', 2000, false),
      // undefined (поле не передано) — не трогать; null — явно сделать глобальным (SNIP-05)
      hostId:
        r['hostId'] === undefined ? undefined : r['hostId'] === null ? null : validateId(r['hostId'], 'hostId')
    });
  });

  ipcMain.handle(IPC.snippetDelete, (event, rawId: unknown): void => {
    assertSenderIsMainWindow(event);
    deleteSnippet(validateId(rawId, 'snippetId'));
  });

  ipcMain.handle(IPC.snippetHostHas, (event, rawHostId: unknown): boolean => {
    assertSenderIsMainWindow(event);
    return hostHasSnippets(validateId(rawHostId, 'hostId'));
  });

  ipcMain.handle(
    IPC.snippetResolveHost,
    (event, rawHostId: unknown, rawAction: unknown): void => {
      assertSenderIsMainWindow(event);
      const hostId = validateId(rawHostId, 'hostId');
      if (rawAction !== 'delete' && rawAction !== 'make-global') {
        throw new IpcValidationError('action: delete|make-global expected');
      }
      resolveHostSnippets(hostId, rawAction);
    }
  );

  ipcMain.handle(
    IPC.snippetFindDuplicate,
    (event, rawCommand: unknown, rawHostId: unknown, rawExcludeId: unknown): Snippet | null => {
      assertSenderIsMainWindow(event);
      const command = str(rawCommand, 'command', 10000)!;
      const hostId =
        rawHostId === undefined || rawHostId === null ? undefined : validateId(rawHostId, 'hostId');
      const excludeId =
        rawExcludeId === undefined || rawExcludeId === null
          ? undefined
          : validateId(rawExcludeId, 'excludeId');
      return findDuplicateSnippet(command, hostId, excludeId);
    }
  );

  // --- SNIP-10: ручная сортировка (один скоуп за раз — все id одного hostId) ---
  ipcMain.handle(IPC.snippetsReorder, (event, rawIds: unknown): void => {
    assertSenderIsMainWindow(event);
    if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 1000) {
      throw new IpcValidationError('orderedIds: non-empty array expected');
    }
    const ids = rawIds.map((id) => validateId(id, 'orderedIds[]'));
    const found = ids.map((id) => getSnippet(id));
    if (found.some((s) => s === null)) throw new IpcValidationError('orderedIds: snippet not found');
    const hostIds = new Set(found.map((s) => s!.hostId ?? null));
    if (hostIds.size > 1) throw new IpcValidationError('orderedIds: snippets span multiple scopes');
    reorderSnippets(ids);
  });
}

function validateSnippetInput(raw: unknown): {
  name: string;
  command: string;
  description?: string;
  hostId?: number;
} {
  if (typeof raw !== 'object' || raw === null) throw new IpcValidationError('input: object');
  const r = raw as Record<string, unknown>;
  return {
    name: str(r['name'], 'name', 100)!,
    command: str(r['command'], 'command', 10000)!,
    description: str(r['description'], 'description', 2000, false),
    hostId:
      r['hostId'] === undefined || r['hostId'] === null ? undefined : validateId(r['hostId'], 'hostId')
  };
}
