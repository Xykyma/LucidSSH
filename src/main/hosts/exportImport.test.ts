import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Host, HostGroup, HostInput } from '@shared/hosts';

const hostExists = vi.fn<(address: string, username: string) => boolean>(() => false);

/**
 * Мини-фейк repository для тестов importHosts (резолв proxyJump по имени,
 * тикет 01) — держит хосты/группы в памяти этого модуля, без реальной SQLite.
 */
let fakeHosts: Array<{ id: number; name: string; proxyJumpHostId?: number }> = [];
let fakeGroups: Array<{ id: number; name: string }> = [];
let nextHostId = 1;
let nextGroupId = 1;

vi.mock('./repository', () => ({
  hostExists: (address: string, username: string) => hostExists(address, username),
  hostNameExists: (name: string) => fakeHosts.some((h) => h.name === name),
  listGroups: () => fakeGroups,
  createGroup: (name: string) => {
    const id = nextGroupId++;
    fakeGroups.push({ id, name });
    return id;
  },
  createHost: (input: HostInput) => {
    const id = nextHostId++;
    fakeHosts.push({ id, name: input.name, proxyJumpHostId: input.proxyJumpHostId });
    return id;
  },
  listHosts: () => fakeHosts.map((h) => ({ id: h.id, name: h.name }) as Host),
  setProxyJumpHostId: (id: number, proxyJumpHostId: number | null) => {
    const h = fakeHosts.find((x) => x.id === id);
    if (h) h.proxyJumpHostId = proxyJumpHostId ?? undefined;
  },
  // Та же логика, что в настоящем repository.checkJumpHost (ADR-0006) — на
  // фейковых хостах этого модуля; сам инвариант проверяется на реальной БД
  // в repository.test.ts.
  checkJumpHost: (jumpHostId: number, hostId?: number): string | null => {
    if (hostId !== undefined && jumpHostId === hostId) return 'self';
    const jump = fakeHosts.find((h) => h.id === jumpHostId);
    if (!jump) return 'not-found';
    if (jump.proxyJumpHostId !== undefined) return 'chain';
    if (hostId !== undefined && fakeHosts.some((h) => h.proxyJumpHostId === hostId)) return 'chain';
    return null;
  }
}));
vi.mock('./keyFile', () => ({
  keyFileExists: (path: string) => path === 'C:\\keys\\id_ed25519'
}));

const {
  buildExport,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  parseImportFile,
  previewImport,
  importHosts
} = await import('./exportImport');

const host: Host = {
  id: 1,
  name: 'web-01',
  address: '203.0.113.10',
  port: 22,
  username: 'root',
  authMethod: 'key',
  keyPath: 'C:\\keys\\id_ed25519',
  groupId: 5,
  guardEnabled: true,
  historyEnabled: true,
  sortOrder: 0,
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z'
};

const group: HostGroup = {
  id: 5,
  name: 'PROD',
  sortOrder: 0,
  collapsed: false,
  createdAt: '2026-07-01T00:00:00Z'
};

describe('buildExport (EXP-01)', () => {
  it('не содержит полей с секретами', () => {
    const out = buildExport([host], [group]);
    const json = JSON.stringify(out).toLowerCase();
    for (const forbidden of ['password', 'passphrase', 'secret', 'privatekey']) {
      expect(json).not.toContain(forbidden);
    }
    // путь к ключу — единственная допустимая ссылка (EXP-01)
    expect(out.hosts[0]?.keyPath).toBe('C:\\keys\\id_ed25519');
    expect(out.hosts[0]?.group).toBe('PROD');
  });
});

describe('parseImportFile (EXP-04)', () => {
  const validFile = JSON.stringify(buildExport([host], [group]));

  it('принимает собственный экспорт (round-trip)', () => {
    const { hosts, groups } = parseImportFile(validFile);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.name).toBe('web-01');
    expect(groups).toEqual(['PROD']);
  });

  it('отклоняет не-JSON и чужой формат', () => {
    expect(() => parseImportFile('not json at all')).toThrow();
    expect(() => parseImportFile('{"hosts": []}')).toThrow(); // нет format
    expect(() => parseImportFile('[]')).toThrow();
    expect(() =>
      parseImportFile(JSON.stringify({ format: 'other', version: 1, hosts: [] }))
    ).toThrow();
  });

  it('отклоняет версию новее поддерживаемой', () => {
    expect(() =>
      parseImportFile(
        JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION + 1, hosts: [] })
      )
    ).toThrow();
  });

  it('отклоняет хост с некорректными полями (та же валидация, что и IPC)', () => {
    const bad = JSON.stringify({
      format: EXPORT_FORMAT,
      version: 1,
      hosts: [{ name: 'x', address: 'evil;rm -rf /', port: 22, username: 'root', authMethod: 'password' }]
    });
    expect(() => parseImportFile(bad)).toThrow();
  });

  it('не исполняет содержимое: поля-строки остаются данными', () => {
    const sneaky = JSON.stringify({
      format: EXPORT_FORMAT,
      version: 1,
      hosts: [
        {
          name: '<script>alert(1)</script>',
          address: 'example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          note: 'require("child_process")'
        }
      ]
    });
    const { hosts } = parseImportFile(sneaky);
    expect(hosts[0]?.name).toBe('<script>alert(1)</script>'); // просто строка
  });
});

describe('previewImport (тикет 03 — предупреждение про ключи)', () => {
  it('считает хостов с методом «ключ», чей файл не найден на этом ПК', () => {
    const missingKeyHost: Host = { ...host, id: 2, keyPath: 'C:\\keys\\missing' };
    const file = JSON.stringify(buildExport([host, missingKeyHost], [group]));
    const preview = previewImport(file);
    expect(preview.missingKeyCount).toBe(1);
    expect(preview.toAdd).toBe(2);
  });

  it('не считает хосты с методом «пароль», даже если keyPath не задан', () => {
    const passwordHost: Host = { ...host, id: 3, authMethod: 'password', keyPath: undefined };
    const file = JSON.stringify(buildExport([passwordHost], [group]));
    const preview = previewImport(file);
    expect(preview.missingKeyCount).toBe(0);
  });

  it('счётчик равен 0, если у всех key-хостов файл ключа найден', () => {
    const file = JSON.stringify(buildExport([host], [group]));
    const preview = previewImport(file);
    expect(preview.missingKeyCount).toBe(0);
  });

  it('не считает конфликтующий (toSkip) хост — он может не импортироваться вовсе', () => {
    hostExists.mockReturnValueOnce(true); // этот хост уйдёт в conflicts, не в toAdd
    const missingKeyHost: Host = { ...host, id: 2, keyPath: 'C:\\keys\\missing' };
    const file = JSON.stringify(buildExport([missingKeyHost], [group]));
    const preview = previewImport(file);
    expect(preview.toSkip).toBe(1);
    expect(preview.missingKeyCount).toBe(0);
  });
});

describe('importHosts — резолв jump-хоста по имени (тикет 01)', () => {
  beforeEach(() => {
    fakeHosts = [];
    fakeGroups = [];
    nextHostId = 1;
    nextGroupId = 1;
    hostExists.mockReturnValue(false);
  });

  it('связывает proxyJump с id хоста того же батча (bastion идёт первым в файле)', () => {
    const bastion: Host = { ...host, id: 1, name: 'bastion' };
    const prodDb: Host = { ...host, id: 2, name: 'prod-db', proxyJumpHostId: 1 };
    const file = JSON.stringify(buildExport([bastion, prodDb], []));

    importHosts(file, 'skip');

    const created = fakeHosts.find((h) => h.name === 'prod-db')!;
    const bastionCreated = fakeHosts.find((h) => h.name === 'bastion')!;
    expect(created.proxyJumpHostId).toBe(bastionCreated.id);
  });

  it('связывает proxyJump, даже если bastion идёт в файле после зависимого хоста', () => {
    const bastion: Host = { ...host, id: 1, name: 'bastion' };
    const prodDb: Host = { ...host, id: 2, name: 'prod-db', proxyJumpHostId: 1 };
    // Экспортируем в обратном порядке — резолв не должен зависеть от порядка строк.
    const file = JSON.stringify(buildExport([prodDb, bastion], []));

    importHosts(file, 'skip');

    const created = fakeHosts.find((h) => h.name === 'prod-db')!;
    const bastionCreated = fakeHosts.find((h) => h.name === 'bastion')!;
    expect(created.proxyJumpHostId).toBe(bastionCreated.id);
  });

  it('связывает proxyJump с уже существующим (не импортируемым) хостом', () => {
    fakeHosts.push({ id: 42, name: 'bastion' });
    nextHostId = 43;
    const file = JSON.stringify({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      groups: [],
      hosts: [{ ...host, name: 'prod-db', proxyJump: 'bastion' }]
    });

    importHosts(file, 'skip');

    const created = fakeHosts.find((h) => h.name === 'prod-db')!;
    expect(created.proxyJumpHostId).toBe(42);
  });

  it('bastion отсутствует и не импортируется — связь молча не восстанавливается', () => {
    const file = JSON.stringify({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      groups: [],
      hosts: [{ ...host, name: 'prod-db', proxyJump: 'unknown-bastion' }]
    });

    importHosts(file, 'skip');

    const created = fakeHosts.find((h) => h.name === 'prod-db')!;
    expect(created.proxyJumpHostId).toBeUndefined();
  });

  it('хост без jump-хоста импортируется без proxyJumpHostId', () => {
    const solo: Host = { ...host, id: 1, name: 'solo' };
    const file = JSON.stringify(buildExport([solo], []));

    importHosts(file, 'skip');

    expect(fakeHosts.find((h) => h.name === 'solo')?.proxyJumpHostId).toBeUndefined();
  });
});
