import { describe, expect, it } from 'vitest';
import { QUICK_CONNECT_HOST_ID, resolveClearTarget, showsSessionChip } from './historyHostFilter';

/**
 * Регрессия (HIST-08, ревью перед 1.0.2): все сессии Быстрого подключения
 * пишутся в историю под одним host_id=0. Раньше этот id считался обычным
 * хостом — чип получал имя последнего сервера, а диалог «Очистить историю
 * хоста X» молча удалял историю всех быстрых подключений сразу.
 */
describe('resolveClearTarget', () => {
  it('«Все» — очистка всей истории', () => {
    expect(resolveClearTarget('all', 5)).toEqual({ kind: 'all' });
  });

  it('чип сохранённого хоста — только этот хост', () => {
    expect(resolveClearTarget(7, 5)).toEqual({ kind: 'host', hostId: 7 });
  });

  it('«Эта сессия» — хост активной сессии', () => {
    expect(resolveClearTarget('session', 5)).toEqual({ kind: 'host', hostId: 5 });
  });

  it('«Эта сессия», но активной сессии уже нет — цель пропала, а не «очистить всё»', () => {
    expect(resolveClearTarget('session', undefined)).toEqual({ kind: 'stale' });
  });

  it('чип Быстрого подключения — вся история быстрых подключений, а не один хост', () => {
    expect(resolveClearTarget(QUICK_CONNECT_HOST_ID, 5)).toEqual({
      kind: 'quickConnect',
      hostId: QUICK_CONNECT_HOST_ID
    });
  });

  it('«Эта сессия» в сессии Быстрого подключения — тоже вся история быстрых подключений', () => {
    expect(resolveClearTarget('session', QUICK_CONNECT_HOST_ID)).toEqual({
      kind: 'quickConnect',
      hostId: QUICK_CONNECT_HOST_ID
    });
  });
});

describe('showsSessionChip', () => {
  it('нет активной сессии — чипа нет', () => {
    expect(showsSessionChip(undefined)).toBe(false);
  });

  it('сессия сохранённого хоста — чип есть', () => {
    expect(showsSessionChip(5)).toBe(true);
  });

  it('сессия Быстрого подключения — чипа нет: её записи и есть чип «Быстрое подключение»', () => {
    expect(showsSessionChip(QUICK_CONNECT_HOST_ID)).toBe(false);
  });
});
