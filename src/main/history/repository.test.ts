import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareOutput } from './repository';

/**
 * Разворачивание вывода команды в истории (Ideas_Backlog.md). Вывод — сырой
 * текст с сервера, поэтому маскируется теми же правилами, что и команда
 * (HIST-07), и не сохраняется вовсе, если сама команда уже была помечена
 * как секретная (двойная защита, §4 CLAUDE.md).
 */

describe('prepareOutput', () => {
  it('обычный короткий вывод сохраняется как есть', () => {
    const result = prepareOutput('total 12\ndrwxr-xr-x 2 root root 4096 file.txt', false);
    expect(result.output).toBe('total 12\ndrwxr-xr-x 2 root root 4096 file.txt');
    expect(result.outputTruncated).toBe(false);
    expect(result.outputHasSecret).toBe(false);
  });

  it('маскирует секрет, обнаруженный прямо в выводе (например, echo $TOKEN)', () => {
    const result = prepareOutput('GITHUB_TOKEN=ghp_leakedFromEnvOutput', false);
    expect(result.output).not.toContain('ghp_leakedFromEnvOutput');
    expect(result.outputHasSecret).toBe(true);
  });

  it('усекает длинный вывод и выставляет outputTruncated', () => {
    const long = 'x'.repeat(5000);
    const result = prepareOutput(long, false);
    expect(result.output).toHaveLength(4000);
    expect(result.outputTruncated).toBe(true);
  });

  it('не усекает вывод ровно на границе лимита', () => {
    const exact = 'x'.repeat(4000);
    const result = prepareOutput(exact, false);
    expect(result.output).toHaveLength(4000);
    expect(result.outputTruncated).toBe(false);
  });

  it('не сохраняет вывод вовсе, если команда уже содержала секрет', () => {
    const result = prepareOutput('some ordinary output, no secrets here', true);
    expect(result.output).toBeNull();
    expect(result.outputTruncated).toBe(false);
    expect(result.outputHasSecret).toBe(false);
  });

  it('пустой/отсутствующий вывод -> null, не падает', () => {
    expect(prepareOutput(undefined, false).output).toBeNull();
    expect(prepareOutput('', false).output).toBeNull();
  });
});

/**
 * Очистка истории по одному хосту (HIST-08, .scratch/history-clear-per-host).
 * Тот же приём мока electron, что и в history/snippets.test.ts —
 * configDir() = app.getPath('userData').
 */
let dir = '';
vi.mock('electron', () => ({
  app: {
    getPath: () => dir,
    getVersion: () => '1.2.3-test'
  }
}));

async function freshRepo(): Promise<typeof import('./repository')> {
  vi.resetModules();
  return import('./repository');
}

describe('clearHistoryForHost / historyCountForHost', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lucidssh-history-test-'));
  });

  afterEach(async () => {
    const { closeHistoryDb } = await import('./db');
    closeHistoryDb();
    rmSync(dir, { recursive: true, force: true });
  });

  const rec = (hostId: number, hostName: string) => ({
    command: `echo ${hostName}`,
    hostId,
    hostName,
    username: 'root'
  });

  it('clearHistoryForHost удаляет только записи своего hostId', async () => {
    const repo = await freshRepo();
    repo.recordHistory(rec(1, 'alpha'));
    repo.recordHistory(rec(1, 'alpha'));
    repo.recordHistory(rec(2, 'beta'));

    repo.clearHistoryForHost(1);

    expect(repo.historyCountForHost(1)).toBe(0);
    expect(repo.historyCountForHost(2)).toBe(1);
    expect(repo.totalHistoryCount()).toBe(1);
  });

  it('historyCountForHost считает верно, включая ноль для хоста без записей', async () => {
    const repo = await freshRepo();
    repo.recordHistory(rec(1, 'alpha'));

    expect(repo.historyCountForHost(1)).toBe(1);
    expect(repo.historyCountForHost(999)).toBe(0);
  });
});

/**
 * Таблетки фильтра истории (HIST-08, .scratch/history-snippet-mark): список
 * хостов по всей таблице, не по странице listHistory (LIMIT 2000).
 */
describe('listHistoryHosts', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lucidssh-history-test-'));
  });

  afterEach(async () => {
    const { closeHistoryDb } = await import('./db');
    closeHistoryDb();
    rmSync(dir, { recursive: true, force: true });
  });

  const rec = (hostId: number, hostName: string) => ({
    command: `echo ${hostName}`,
    hostId,
    hostName,
    username: 'root'
  });

  it('включает хосты, чьи строки все старше последних 2000 (вне LIMIT listHistory)', async () => {
    const repo = await freshRepo();
    repo.recordHistory(rec(1, 'alpha')); // единственная, старейшая строка хоста 1
    for (let i = 0; i < 2001; i++) repo.recordHistory(rec(2, 'beta'));

    // Хост 1 вытеснен лимитом 2000 из страницы...
    expect(repo.listHistory().some((e) => e.hostId === 1)).toBe(false);
    // ...но не из списка таблеток — он читает всю таблицу.
    expect(repo.listHistoryHosts().find((c) => c.hostId === 1)).toEqual({
      hostId: 1,
      hostName: 'alpha'
    });
  });

  it('имя хоста — из самой свежей строки', async () => {
    const repo = await freshRepo();
    repo.recordHistory(rec(1, 'alpha-old'));
    repo.recordHistory(rec(1, 'alpha-new'));

    expect(repo.listHistoryHosts().find((c) => c.hostId === 1)?.hostName).toBe('alpha-new');
  });

  it('исчезает после clearHistoryForHost', async () => {
    const repo = await freshRepo();
    repo.recordHistory(rec(1, 'alpha'));
    repo.recordHistory(rec(2, 'beta'));

    repo.clearHistoryForHost(1);

    const chips = repo.listHistoryHosts();
    expect(chips.some((c) => c.hostId === 1)).toBe(false);
    expect(chips.some((c) => c.hostId === 2)).toBe(true);
  });
});
