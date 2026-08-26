import type { Host, HostGroup, HostInput, ImportPreview } from '@shared/hosts';
import { validateHostInput } from './validate';
import { keyFileExists } from './keyFile';
import { resolveHostRefByName } from './resolveByName';
import * as repo from './repository';

/**
 * Экспорт/импорт хостов в JSON (EXP-01…EXP-04).
 * Секреты НЕ экспортируются — только путь к файлу ключа (EXP-01).
 * Импортируемый JSON — недоверенные данные: строгая валидация схемы,
 * содержимое не исполняется (EXP-04).
 */

export const EXPORT_FORMAT = 'lucidssh-hosts';
export const EXPORT_VERSION = 1;

interface ExportedGroup {
  name: string;
  collapsed: boolean;
}

interface ExportedHost {
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: string;
  keyPath?: string;
  group?: string; // имя группы, не id — переносимо между машинами
  /**
   * Имя jump-хоста (не id — id не переносим между машинами, как и group).
   * На импорте резолвится обратно в proxyJumpHostId по точному совпадению
   * имени (importHosts, тем же принципом, что и group) — среди уже имеющихся
   * хостов и хостов, импортированных в этом же батче. Если совпадения нет —
   * связь молча не восстанавливается (как и при несовпадении group).
   */
  proxyJump?: string;
  note?: string;
  guardEnabled: boolean;
  /** HIST-07. Терпимое чтение с дефолтом true на импорте — старые файлы
   *  (EXPORT_VERSION 1, без этого поля) читаются и новой сборкой, и старая
   *  сборка молча игнорирует поле, которого не знает: EXPORT_VERSION не
   *  поднимается (.scratch/host-scoped-flags-to-db). */
  historyEnabled: boolean;
}

export interface HostsExportFile {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  groups: ExportedGroup[];
  hosts: ExportedHost[];
}

export function buildExport(hosts: Host[], groups: HostGroup[]): HostsExportFile {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const hostById = new Map(hosts.map((h) => [h.id, h]));
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    groups: groups.map((g) => ({ name: g.name, collapsed: g.collapsed })),
    hosts: hosts.map((h) => ({
      name: h.name,
      address: h.address,
      port: h.port,
      username: h.username,
      authMethod: h.authMethod,
      // ВАЖНО: никаких паролей/passphrase/содержимого ключей (EXP-01)
      keyPath: h.keyPath,
      group: h.groupId !== undefined ? groupById.get(h.groupId)?.name : undefined,
      proxyJump:
        h.proxyJumpHostId !== undefined ? hostById.get(h.proxyJumpHostId)?.name : undefined,
      note: h.note,
      guardEnabled: h.guardEnabled,
      historyEnabled: h.historyEnabled
    }))
  };
}

export class ImportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportFormatError';
  }
}

/** Парсит и валидирует файл импорта. Бросает ImportFormatError с понятной причиной. */
export function parseImportFile(json: string): { hosts: HostInput[]; groups: string[] } {
  if (json.length > 5_000_000) throw new ImportFormatError('file too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ImportFormatError('not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ImportFormatError('unexpected structure');
  }
  const root = parsed as Record<string, unknown>;
  if (root['format'] !== EXPORT_FORMAT) throw new ImportFormatError('unknown format');
  if (typeof root['version'] !== 'number' || root['version'] > EXPORT_VERSION) {
    throw new ImportFormatError('unsupported version');
  }
  if (!Array.isArray(root['hosts'])) throw new ImportFormatError('hosts array missing');
  if (root['hosts'].length > 10_000) throw new ImportFormatError('too many hosts');

  const groupNames = new Set<string>();
  const hosts: HostInput[] = [];
  const hostGroupNames: (string | undefined)[] = [];
  const hostProxyJumpNames: (string | undefined)[] = [];

  for (const rawHost of root['hosts']) {
    if (typeof rawHost !== 'object' || rawHost === null) {
      throw new ImportFormatError('host entry is not an object');
    }
    const rec = rawHost as Record<string, unknown>;
    const groupName =
      typeof rec['group'] === 'string' && rec['group'].length > 0 && rec['group'].length <= 60
        ? rec['group']
        : undefined;
    const proxyJumpName =
      typeof rec['proxyJump'] === 'string' &&
      rec['proxyJump'].length > 0 &&
      rec['proxyJump'].length <= 100
        ? rec['proxyJump']
        : undefined;
    // Каждый хост проходит ту же строгую валидацию, что и IPC-ввод (EXP-04).
    // rec['proxyJump'] (имя bastion-хоста) сюда не передаётся — validateHostInput
    // ждёт proxyJumpHostId (число); резолв по имени происходит позже, в importHosts,
    // когда доступен полный список хостов (свежесозданных + уже существующих).
    const input = validateHostInput({
      name: rec['name'],
      address: rec['address'],
      port: rec['port'],
      username: rec['username'],
      authMethod: rec['authMethod'],
      keyPath: rec['keyPath'],
      note: rec['note'],
      guardEnabled: typeof rec['guardEnabled'] === 'boolean' ? rec['guardEnabled'] : true,
      historyEnabled: typeof rec['historyEnabled'] === 'boolean' ? rec['historyEnabled'] : true
    });
    if (groupName) groupNames.add(groupName);
    hostGroupNames.push(groupName);
    hostProxyJumpNames.push(proxyJumpName);
    hosts.push(input);
  }

  // groupId/proxyJumpHostId проставляются при импорте; здесь возвращаем сырые
  // имена отдельно, соответствие восстанавливается по индексу.
  return {
    hosts: hosts.map(
      (h, i) =>
        ({
          ...h,
          groupName: hostGroupNames[i],
          proxyJumpName: hostProxyJumpNames[i]
        }) as HostInputWithGroup
    ),
    groups: [...groupNames]
  };
}

export type HostInputWithGroup = HostInput & { groupName?: string; proxyJumpName?: string };

export function previewImport(json: string): ImportPreview {
  const { hosts } = parseImportFile(json);
  let toAdd = 0;
  let missingKeyCount = 0;
  const conflicts: ImportPreview['conflicts'] = [];
  for (const h of hosts) {
    if (repo.hostExists(h.address, h.username)) {
      conflicts.push({ name: h.name, address: h.address, username: h.username });
      continue; // конфликтующий хост может быть пропущен и не создастся — ключ ему не понадобится
    }
    toAdd++;
    if (h.authMethod === 'key' && !keyFileExists(h.keyPath ?? '')) {
      missingKeyCount++;
    }
  }
  return { toAdd, toSkip: conflicts.length, conflicts, missingKeyCount };
}

/** Импорт: конфликт (address+username совпали) — пропустить или переименовать (EXP-02). */
export function importHosts(
  json: string,
  conflictStrategy: 'skip' | 'rename'
): { imported: number; skipped: number } {
  const { hosts, groups } = parseImportFile(json);

  const groupIdByName = new Map<string, number>();
  for (const g of repo.listGroups()) groupIdByName.set(g.name, g.id);
  for (const name of groups) {
    if (!groupIdByName.has(name)) groupIdByName.set(name, repo.createGroup(name));
  }

  let imported = 0;
  let skipped = 0;
  // (id нового хоста, имя его jump-хоста) — резолвится вторым проходом, когда
  // весь батч уже записан в БД (jump-хост мог идти в файле после зависимого).
  const pendingProxyJump: Array<{ id: number; proxyJumpName: string }> = [];

  for (const h of hosts as HostInputWithGroup[]) {
    const { groupName, proxyJumpName, ...input } = h;
    if (repo.hostExists(input.address, input.username)) {
      if (conflictStrategy === 'skip') {
        skipped++;
        continue;
      }
      // rename: подобрать свободное имя «name (2)», «name (3)»…
      let candidate = input.name;
      let n = 2;
      while (repo.hostNameExists(candidate)) {
        candidate = `${input.name} (${n++})`;
      }
      input.name = candidate;
    }
    const id = repo.createHost({
      ...input,
      groupId: groupName ? groupIdByName.get(groupName) : undefined
    });
    if (proxyJumpName) pendingProxyJump.push({ id, proxyJumpName });
    imported++;
  }

  // Резолв jump-хоста по имени — среди уже имеющихся хостов и хостов, только что
  // импортированных в этом же батче (их итоговые, возможно переименованные, имена).
  if (pendingProxyJump.length > 0) {
    const allHosts = repo.listHosts();
    for (const { id, proxyJumpName } of pendingProxyJump) {
      const jumpId = resolveHostRefByName(allHosts, proxyJumpName);
      // Как и в externalImport.ts: связь ставится только если не создаёт
      // второй прыжок (ADR-0006) — импорт не должен собирать конфигурацию,
      // которую форма подключения собрать не даст.
      if (jumpId !== null && repo.checkJumpHost(jumpId, id) === null) {
        repo.setProxyJumpHostId(id, jumpId);
      }
    }
  }

  return { imported, skipped };
}
