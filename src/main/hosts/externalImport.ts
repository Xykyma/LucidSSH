import { userInfo } from 'node:os';
import type { ExternalImportApplyResult, ImportedHost } from '@shared/import';
import type { HostInput } from '@shared/hosts';
import { validateHostInput } from './validate';
import { resolveHostRefByName } from './resolveByName';
import * as repo from './repository';

/**
 * Применение импорта из внешних источников (HM-03/HM-04). Каждый хост проходит
 * ту же строгую валидацию, что и обычный ввод; невалидные записи пропускаются,
 * а не роняют весь импорт. Секретов здесь нет — только путь к файлу ключа.
 */

function fallbackUsername(): string {
  try {
    const u = userInfo().username;
    // Приводим к допустимому формату (POSIX-подобный логин)
    const safe = u.replace(/[^A-Za-z0-9._-]/g, '');
    return safe.length > 0 ? safe : 'user';
  } catch {
    return 'user';
  }
}

/**
 * ImportedHost → сырой HostInput для валидации (guardEnabled/historyEnabled по
 * умолчанию включены). `h.proxyJump` (сырой алиас из ~/.ssh/config, HM-04) сюда
 * не передаётся — резолв алиаса в proxyJumpHostId происходит отдельно, после
 * того как импортируемые хосты уже записаны в БД (тикет 06, см. ниже).
 */
function toRawInput(h: ImportedHost, defaultUser: string): Record<string, unknown> {
  return {
    name: h.name,
    address: h.address,
    port: h.port,
    username: h.username && h.username.length > 0 ? h.username : defaultUser,
    authMethod: h.authMethod,
    keyPath: h.keyPath,
    note: h.note,
    guardEnabled: true,
    historyEnabled: true
  };
}

export function applyExternalImport(
  hosts: ImportedHost[],
  conflictStrategy: 'skip' | 'rename'
): ExternalImportApplyResult {
  const defaultUser = fallbackUsername();
  let imported = 0;
  let skipped = 0;
  // id + сырой алиас ProxyJump — резолвится вторым проходом, когда все
  // хосты батча уже в БД (алиас может ссылаться на хост, идущий в списке
  // позже него самого).
  const pendingProxyJump: Array<{ id: number; name: string; alias: string }> = [];

  for (const h of hosts) {
    let input: HostInput;
    try {
      input = validateHostInput(toRawInput(h, defaultUser));
    } catch {
      skipped++; // невалидная запись (например, адрес с недопустимыми символами)
      continue;
    }

    if (repo.hostExists(input.address, input.username)) {
      if (conflictStrategy === 'skip') {
        skipped++;
        continue;
      }
      let candidate = input.name;
      let n = 2;
      while (repo.hostNameExists(candidate)) candidate = `${input.name} (${n++})`;
      input.name = candidate;
    }
    const id = repo.createHost(input);
    imported++;
    if (h.proxyJump) pendingProxyJump.push({ id, name: input.name, alias: h.proxyJump });
  }

  const unresolvedProxyJump: string[] = [];
  if (pendingProxyJump.length > 0) {
    // Полный список хостов уже с учётом всех только что созданных — резолв
    // видит и существующие, и импортированные в этом же батче хосты.
    const allHosts = repo.listHosts();
    for (const p of pendingProxyJump) {
      const resolvedId = resolveHostRefByName(allHosts, p.alias);
      // checkJumpHost смотрит текущее состояние БД, а связи проставляются
      // по очереди — поэтому цепочка внутри одного батча (A→B, B→C) рвётся
      // на втором звене, а не создаётся молча в обход ADR-0006.
      if (resolvedId !== null && repo.checkJumpHost(resolvedId, p.id) === null) {
        repo.setProxyJumpHostId(p.id, resolvedId);
      } else {
        unresolvedProxyJump.push(p.name);
      }
    }
  }

  return { imported, skipped, unresolvedProxyJump };
}
