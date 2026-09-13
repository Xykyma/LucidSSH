import { describe, expect, it } from 'vitest';
import {
  validateGroupName,
  validateHostInput,
  validateHistoryHostId,
  validateId,
  validateOptionalHostId,
  validateSecret
} from './validate';

const valid = {
  name: 'web-01',
  address: '203.0.113.10',
  port: 22,
  username: 'root',
  authMethod: 'password',
  guardEnabled: true,
  historyEnabled: true
};

describe('validateHostInput', () => {
  it('принимает корректный минимальный ввод', () => {
    const out = validateHostInput(valid);
    expect(out.name).toBe('web-01');
    expect(out.port).toBe(22);
  });

  it('отклоняет не-объект', () => {
    expect(() => validateHostInput(null)).toThrow();
    expect(() => validateHostInput('x')).toThrow();
    expect(() => validateHostInput([valid])).toThrow();
  });

  it('отклоняет некорректный порт', () => {
    for (const port of [0, -1, 65536, 1.5, '22', NaN]) {
      expect(() => validateHostInput({ ...valid, port })).toThrow();
    }
  });

  it('отклоняет слишком длинные строки', () => {
    expect(() => validateHostInput({ ...valid, name: 'a'.repeat(101) })).toThrow();
    expect(() => validateHostInput({ ...valid, address: 'a'.repeat(256) })).toThrow();
  });

  it('отклоняет опасные символы в адресе и имени пользователя', () => {
    expect(() => validateHostInput({ ...valid, address: 'host;rm -rf /' })).toThrow();
    expect(() => validateHostInput({ ...valid, address: 'host `x`' })).toThrow();
    expect(() => validateHostInput({ ...valid, username: 'root; whoami' })).toThrow();
  });

  it('требует keyPath при authMethod=key', () => {
    expect(() => validateHostInput({ ...valid, authMethod: 'key' })).toThrow();
    const out = validateHostInput({ ...valid, authMethod: 'key', keyPath: 'C:\\keys\\id_ed25519' });
    expect(out.keyPath).toContain('id_ed25519');
  });

  it('отклоняет неизвестный authMethod', () => {
    expect(() => validateHostInput({ ...valid, authMethod: 'agent' })).toThrow();
  });

  it('groupId — только положительное целое', () => {
    for (const groupId of [0, -5, 1.2, 'x']) {
      expect(() => validateHostInput({ ...valid, groupId })).toThrow();
    }
    expect(validateHostInput({ ...valid, groupId: 3 }).groupId).toBe(3);
  });

  it('proxyJumpHostId — только положительное целое, ссылка на хост', () => {
    for (const proxyJumpHostId of [0, -5, 1.2, 'bastion']) {
      expect(() => validateHostInput({ ...valid, proxyJumpHostId })).toThrow();
    }
    expect(validateHostInput({ ...valid, proxyJumpHostId: 7 }).proxyJumpHostId).toBe(7);
    expect(validateHostInput(valid).proxyJumpHostId).toBeUndefined();
  });
});

describe('validateSecret', () => {
  it('пустое значение → undefined', () => {
    expect(validateSecret(undefined)).toBeUndefined();
    expect(validateSecret('')).toBeUndefined();
  });
  it('не-строка и сверхдлинное → ошибка', () => {
    expect(() => validateSecret(42)).toThrow();
    expect(() => validateSecret('a'.repeat(1025))).toThrow();
  });
});

describe('validateGroupName / validateId', () => {
  it('групповое имя обрезается и не может быть пустым', () => {
    expect(validateGroupName('  Prod  ')).toBe('Prod');
    expect(() => validateGroupName('   ')).toThrow();
    expect(() => validateGroupName('a'.repeat(61))).toThrow();
  });
  it('id — только положительное целое', () => {
    expect(validateId(7)).toBe(7);
    for (const bad of [0, -1, 1.5, '7', null]) {
      expect(() => validateId(bad)).toThrow();
    }
  });
});

describe('validateOptionalHostId', () => {
  it('отсутствие контекста хоста → undefined', () => {
    expect(validateOptionalHostId(undefined)).toBeUndefined();
    expect(validateOptionalHostId(null)).toBeUndefined();
  });

  it('0 — сентинел Быстрого подключения (HM-11) → undefined, а не ошибка', () => {
    expect(validateOptionalHostId(0)).toBeUndefined();
  });

  it('положительный id проходит как есть', () => {
    expect(validateOptionalHostId(42)).toBe(42);
  });

  it('остальной мусор по-прежнему отклоняется', () => {
    for (const bad of [-1, 1.5, '7', {}, true, NaN]) {
      expect(() => validateOptionalHostId(bad)).toThrow();
    }
  });
});

/**
 * Регрессия (HIST-08, .scratch/history-clear-per-host): очистка и подсчёт
 * истории изначально проверяли hostId через validateId (>=1), и для Быстрого
 * подключения диалог подтверждения молча не открывался.
 */
describe('validateHistoryHostId', () => {
  it('0 — сентинел Быстрого подключения (HM-11) — настоящая цель, а не ошибка', () => {
    expect(validateHistoryHostId(0)).toBe(0);
  });

  it('положительный id хоста проходит как есть', () => {
    expect(validateHistoryHostId(5)).toBe(5);
  });

  it('остальной мусор отклоняется', () => {
    for (const bad of [-1, 1.5, '0', undefined, null, NaN]) {
      expect(() => validateHistoryHostId(bad)).toThrow();
    }
  });
});
