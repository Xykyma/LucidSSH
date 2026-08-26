import type { AuthMethod, Host, HostGroup, HostInput } from '@shared/hosts';
import { openHostsDb } from './db';

/**
 * CRUD хостов и групп (HM-01, HM-02). Только параметризованные запросы.
 * Секретов здесь нет: пароль/passphrase живёт в keychain (SEC-01).
 */

interface HostRow {
  id: number;
  name: string;
  address: string;
  port: number;
  username: string;
  auth_method: string;
  key_path: string | null;
  group_id: number | null;
  proxy_jump_host_id: number | null;
  note: string | null;
  guard_enabled: number;
  history_enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface GroupRow {
  id: number;
  name: string;
  sort_order: number;
  collapsed: number;
  created_at: string;
}

function rowToHost(r: HostRow): Host {
  return {
    id: r.id,
    name: r.name,
    address: r.address,
    port: r.port,
    username: r.username,
    authMethod: r.auth_method as AuthMethod,
    keyPath: r.key_path ?? undefined,
    groupId: r.group_id ?? undefined,
    proxyJumpHostId: r.proxy_jump_host_id ?? undefined,
    note: r.note ?? undefined,
    guardEnabled: r.guard_enabled === 1,
    historyEnabled: r.history_enabled === 1,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

function rowToGroup(r: GroupRow): HostGroup {
  return {
    id: r.id,
    name: r.name,
    sortOrder: r.sort_order,
    collapsed: r.collapsed === 1,
    createdAt: r.created_at
  };
}

// --- Хосты ---

export function listHosts(): Host[] {
  const rows = openHostsDb()
    .prepare('SELECT * FROM hosts ORDER BY sort_order, name COLLATE NOCASE')
    .all() as HostRow[];
  return rows.map(rowToHost);
}

export function getHost(id: number): Host | null {
  const row = openHostsDb().prepare('SELECT * FROM hosts WHERE id = ?').get(id) as
    | HostRow
    | undefined;
  return row ? rowToHost(row) : null;
}

export function createHost(input: HostInput): number {
  const now = new Date().toISOString();
  const res = openHostsDb()
    .prepare(
      `INSERT INTO hosts (name, address, port, username, auth_method, key_path,
         group_id, proxy_jump_host_id, note, guard_enabled, history_enabled, sort_order, created_at, updated_at)
       VALUES (@name, @address, @port, @username, @authMethod, @keyPath,
         @groupId, @proxyJumpHostId, @note, @guardEnabled, @historyEnabled, @sortOrder, @createdAt, @updatedAt)`
    )
    .run({
      name: input.name,
      address: input.address,
      port: input.port,
      username: input.username,
      authMethod: input.authMethod,
      keyPath: input.keyPath ?? null,
      groupId: input.groupId ?? null,
      proxyJumpHostId: input.proxyJumpHostId ?? null,
      note: input.note ?? null,
      guardEnabled: input.guardEnabled ? 1 : 0,
      historyEnabled: input.historyEnabled ? 1 : 0,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now
    });
  return Number(res.lastInsertRowid);
}

export function updateHost(id: number, input: HostInput): void {
  openHostsDb()
    .prepare(
      `UPDATE hosts SET name=@name, address=@address, port=@port, username=@username,
         auth_method=@authMethod, key_path=@keyPath, group_id=@groupId,
         proxy_jump_host_id=@proxyJumpHostId, note=@note, guard_enabled=@guardEnabled,
         history_enabled=@historyEnabled, updated_at=@updatedAt
       WHERE id=@id`
    )
    .run({
      id,
      name: input.name,
      address: input.address,
      port: input.port,
      username: input.username,
      authMethod: input.authMethod,
      keyPath: input.keyPath ?? null,
      groupId: input.groupId ?? null,
      proxyJumpHostId: input.proxyJumpHostId ?? null,
      note: input.note ?? null,
      guardEnabled: input.guardEnabled ? 1 : 0,
      historyEnabled: input.historyEnabled ? 1 : 0,
      updatedAt: new Date().toISOString()
    });
}

export function deleteHost(id: number): void {
  openHostsDb().prepare('DELETE FROM hosts WHERE id = ?').run(id);
}

/** Порядок хостов внутри группы (drag-and-drop в сайдбаре). */
export function reorderHosts(orderedIds: number[]): void {
  const db = openHostsDb();
  const update = db.prepare('UPDATE hosts SET sort_order = ? WHERE id = ?');
  const run = db.transaction((ids: number[]) => {
    ids.forEach((id, index) => update.run(index, id));
  });
  run(orderedIds);
}

/** Для показа имени сервера рядом с known_hosts (SET-04). */
export function findHostByAddressPort(address: string, port: number): Host | null {
  const row = openHostsDb()
    .prepare('SELECT * FROM hosts WHERE address = ? AND port = ? LIMIT 1')
    .get(address, port) as HostRow | undefined;
  return row ? rowToHost(row) : null;
}

export function hostExists(address: string, username: string): boolean {
  const row = openHostsDb()
    .prepare('SELECT 1 FROM hosts WHERE address = ? AND username = ? LIMIT 1')
    .get(address, username);
  return row !== undefined;
}

/** Точечное обновление jump-хоста без перезаписи остальных полей (используется импортом). */
export function setProxyJumpHostId(id: number, proxyJumpHostId: number | null): void {
  openHostsDb()
    .prepare('UPDATE hosts SET proxy_jump_host_id = ? WHERE id = ?')
    .run(proxyJumpHostId, id);
}

/** Почему связку «хост → jump-хост» принимать нельзя (null — можно). */
export type JumpHostRejection = 'self' | 'not-found' | 'chain';

/**
 * Единственная проверка инварианта single-hop (ADR-0006) на стороне данных.
 * Фильтр списка в форме подключения — только первая линия: он не защищает ни
 * импорт, ни прямой вызов IPC-канала, ни редактирование хоста, который сам уже
 * служит чьим-то jump-хостом. Поэтому решение принимается здесь, а UI и импорт
 * зовут одно и то же.
 *
 * `hostId` — id хоста, которому назначается jump (undefined при создании
 * нового: у нового хоста ещё не может быть зависимых).
 */
export function checkJumpHost(jumpHostId: number, hostId?: number): JumpHostRejection | null {
  if (hostId !== undefined && jumpHostId === hostId) return 'self';
  const jump = getHost(jumpHostId);
  if (!jump) return 'not-found';
  // Второй прыжок с той стороны: выбранный bastion сам ходит через кого-то.
  if (jump.proxyJumpHostId !== undefined) return 'chain';
  // Второй прыжок с этой стороны: хост сам служит чьим-то bastion'ом.
  if (hostId !== undefined && listHostsReferencingProxyJump(hostId).length > 0) return 'chain';
  return null;
}

/** Хосты, у которых jump-хостом настроен именно `hostId` (для предупреждения об удалении). */
export function listHostsReferencingProxyJump(hostId: number): Host[] {
  const rows = openHostsDb()
    .prepare('SELECT * FROM hosts WHERE proxy_jump_host_id = ?')
    .all(hostId) as HostRow[];
  return rows.map(rowToHost);
}

export function hostNameExists(name: string): boolean {
  const row = openHostsDb().prepare('SELECT 1 FROM hosts WHERE name = ? LIMIT 1').get(name);
  return row !== undefined;
}

// --- Группы ---

export function listGroups(): HostGroup[] {
  const rows = openHostsDb()
    .prepare('SELECT * FROM groups ORDER BY sort_order, name COLLATE NOCASE')
    .all() as GroupRow[];
  return rows.map(rowToGroup);
}

export function createGroup(name: string): number {
  const res = openHostsDb()
    .prepare('INSERT INTO groups (name, sort_order, collapsed, created_at) VALUES (?, 0, 0, ?)')
    .run(name, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

export function renameGroup(id: number, name: string): void {
  openHostsDb().prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, id);
}

/** Состояние дерева сохраняется между запусками (HM-02). */
export function setGroupCollapsed(id: number, collapsed: boolean): void {
  openHostsDb().prepare('UPDATE groups SET collapsed = ? WHERE id = ?').run(collapsed ? 1 : 0, id);
}

/** Хосты группы не удаляются — уходят в «без группы» (ON DELETE SET NULL). */
export function deleteGroup(id: number): void {
  openHostsDb().prepare('DELETE FROM groups WHERE id = ?').run(id);
}

export function groupExists(id: number): boolean {
  return openHostsDb().prepare('SELECT 1 FROM groups WHERE id = ? LIMIT 1').get(id) !== undefined;
}
