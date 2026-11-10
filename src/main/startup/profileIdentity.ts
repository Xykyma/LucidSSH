import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, isPortableBuild } from '../config/store';

/**
 * Постоянная идентичность Переносимого профиля (NFR-05): один строго
 * валидируемый случайный UUID в файле `profile.id` рядом с portable exe. ID —
 * не секрет, но его потеря или замена молча отрезали бы пользователя от
 * сохранённых секретов (адресация portable-записей Хранилища включает
 * profileId), поэтому существующий профиль с отсутствующим/повреждённым ID
 * запуск не получает — без регенерации, открытия хранилищ и перезаписи файлов.
 *
 * Системный профиль установленной версии и dev-режим идентичность не
 * получают: у существующих установок нет profile.id, и блокировать их
 * обновление до 1.1 нельзя.
 */

export const PROFILE_ID_FILE = 'profile.id';

/** Известные артефакты данных LucidSSH: без profile.id рядом с любым из них
 * папка считается существующим профилем с утраченной идентичностью, а не
 * новой. Сам exe и посторонние файлы профилем не делают. Каталог `backups` и
 * sidecar-копии `<db>.backup-vN` (Data_Structures §3.6) — тоже данные. */
const KNOWN_ARTIFACTS = ['config.json', 'hosts.db', 'history.db', 'known_hosts', 'backups'] as const;

/** Канонический UUID (любой версии 1–5, вариант RFC 4122), регистр не важен. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ProfileIdentityError = 'artifactsWithoutId' | 'invalidId' | 'createFailed';

export type ProfileIdentityResult =
  | { ok: true; profileId: string | null }
  | { ok: false; error: ProfileIdentityError };

let cached: string | null = null;

/** ID подготовленного профиля; null — системный профиль/dev (не portable). */
export function getProfileId(): string | null {
  return cached;
}

export function prepareProfileIdentity(): ProfileIdentityResult {
  if (!isPortableBuild()) return { ok: true, profileId: null };
  const dir = configDir();
  const idPath = join(dir, PROFILE_ID_FILE);

  if (existsSync(idPath)) {
    let raw: string;
    try {
      raw = readFileSync(idPath, 'utf8').trim();
    } catch {
      return { ok: false, error: 'invalidId' };
    }
    if (!UUID_RE.test(raw)) return { ok: false, error: 'invalidId' };
    // Адресация секретов чувствительна к регистру — ID работаем в нижнем.
    cached = raw.toLowerCase();
    return { ok: true, profileId: cached };
  }

  if (hasProfileArtifacts(dir)) {
    return { ok: false, error: 'artifactsWithoutId' };
  }

  // Новый профиль: profile.id создаётся атомарно (tmp + rename) и проверяется
  // перечитыванием до того, как откроются БД и создадутся остальные файлы.
  const tmp = idPath + '.tmp';
  try {
    mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    writeFileSync(tmp, id, 'utf8');
    renameSync(tmp, idPath);
    if (!UUID_RE.test(readFileSync(idPath, 'utf8').trim())) {
      // Недописанный файл не оставляем: иначе следующий запуск сообщит
      // уже invalidId, а не причину сбоя записи.
      rmSync(idPath, { force: true });
      return { ok: false, error: 'createFailed' };
    }
    cached = id;
    return { ok: true, profileId: id };
  } catch {
    rmSync(tmp, { force: true });
    return { ok: false, error: 'createFailed' };
  }
}

function hasProfileArtifacts(dir: string): boolean {
  if (KNOWN_ARTIFACTS.some((name) => existsSync(join(dir, name)))) return true;
  // sidecar-копии `<db>.backup-vN` рядом с БД (копия перед миграцией)
  try {
    return readdirSync(dir).some(
      (name) => name.startsWith('hosts.db.backup-v') || name.startsWith('history.db.backup-v')
    );
  } catch {
    return false; // каталога нет — артефактов тоже
  }
}
