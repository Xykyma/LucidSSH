import { describe, expect, it } from 'vitest';
import { validateHistoryHostId } from './history';

/**
 * Регрессия (HIST-08, .scratch/history-clear-per-host): hostId=0 — сентинел
 * Быстрого подключения (HM-11) — реальный host_id в истории, а не «контекст
 * не задан». historyCountForHost/historyClearForHost изначально проверяли
 * hostId через validateId (>=1), из-за чего очистка истории «этой сессии»
 * для Быстрого подключения падала с IpcValidationError и диалог подтверждения
 * молча не открывался.
 */
describe('validateHistoryHostId', () => {
  it('принимает 0 (Быстрое подключение, HM-11)', () => {
    expect(validateHistoryHostId(0)).toBe(0);
  });

  it('принимает положительный id хоста', () => {
    expect(validateHistoryHostId(5)).toBe(5);
  });

  it('отклоняет отрицательные числа', () => {
    expect(() => validateHistoryHostId(-1)).toThrow();
  });

  it('отклоняет дробные числа', () => {
    expect(() => validateHistoryHostId(1.5)).toThrow();
  });

  it('отклоняет не-числа', () => {
    expect(() => validateHistoryHostId('0')).toThrow();
    expect(() => validateHistoryHostId(undefined)).toThrow();
    expect(() => validateHistoryHostId(null)).toThrow();
  });
});
