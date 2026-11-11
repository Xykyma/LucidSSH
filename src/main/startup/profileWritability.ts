import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, isPortableBuild } from '../config/store';

/**
 * Проверка записываемости Переносимого профиля (NFR-05, тикет 03): portable-
 * сборка запускается, только когда может безопасно сохранять весь существующий
 * профиль — папку, конфигурацию, обе БД, known_hosts, sidecar-копии и каталог
 * резервных копий. Проверка — реальными пробами записи (создание/удаление
 * временного файла, запись в БД с откатом, включая WAL-режим), а не атрибутами
 * ФС; пробы не меняют пользовательское содержимое и не оставляют временных
 * файлов. Любой отказ — блокирующая локализованная ошибка с именем проблемного
 * файла, до открытия хранилищ и миграций; fallback в системный профиль,
 * read-only режим и частичный запуск без сохранения запрещены.
 *
 * Проверка не обещает защиту от будущего заполнения диска, извлечения
 * носителя или смены прав во время работы — штатная обработка ошибок
 * операций (см. openLocalStores) сохраняется.
 *
 * Проба БД переводит файл в WAL на persistently — это осознанно: так же
 * ведут себя openHostsDb/openHistoryDb при обычном открытии, поэтому проверка
 * не меняет ни поведения, ни пользовательских данных (проба с откатом).
 */

export type ProfileWritabilityResult = { ok: true } | { ok: false; file: string };

/** probe-файлы уникальны и не пересекаются с известными артефактами профиля. */
function probeName(): string {
  return `.lucidssh-writability-probe-${process.pid}-${randomUUID()}`;
}

/** Реальное создание и удаление временного файла: каталог доступен на запись. */
function checkDirWritable(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const probe = join(dir, probeName());
  writeFileSync(probe, '');
  rmSync(probe, { force: true });
}

/** Право на запись без изменения содержимого: append пустой строки требует
 *  доступа на запись к файлу, но не трогает его содержимое. */
function checkFileWritable(path: string): void {
  appendFileSync(path, '');
}

/**
 * Проба записи в БД с откатом: открывает сам файл и переводит в WAL (как
 * делают openHostsDb/openHistoryDb), затем пишет в транзакции и откатывает.
 * Невозможность WAL тоже отказ: иначе приложение молча заработало бы не в
 * том журнальном режиме и по-другому стало бы хранить профиль.
 */
function checkDbWritable(path: string): void {
  const db = new Database(path);
  try {
    const mode = db.pragma('journal_mode = WAL', { simple: true }) as string;
    if (mode !== 'wal') throw new Error(`journal_mode=${mode}`);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('CREATE TABLE __lucidssh_writability_probe (v INTEGER)');
      db.exec('INSERT INTO __lucidssh_writability_probe VALUES (1)');
      db.exec('ROLLBACK');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // транзакции уже нет — не маскируем первопричину
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

/** Каталог резервных копий (UPD-04): создание недостающего, запись внутри и
 *  создание подкаталога (реальная копия — `backups/pre-update-<ts>/`). Только
 *  что созданный пустой каталог убирается, чтобы профиль остался тем, чем
 *  был; существующий каталог с пользовательскими копиями не трогаем. */
function checkBackupsWritable(backupsDir: string): void {
  const created = !existsSync(backupsDir);
  try {
    checkDirWritable(backupsDir);
    const probeSubdir = join(backupsDir, probeName());
    mkdirSync(probeSubdir);
    writeFileSync(join(probeSubdir, 'probe'), '');
    rmSync(probeSubdir, { recursive: true, force: true });
  } finally {
    if (created) rmSync(backupsDir, { recursive: true, force: true });
  }
}

export function checkProfileWritability(): ProfileWritabilityResult {
  if (!isPortableBuild()) return { ok: true };
  const dir = configDir();

  try {
    checkDirWritable(dir);
  } catch {
    return { ok: false, file: dir };
  }

  // Существующие текстовые файлы: конфигурация и доверенные ключи серверов.
  for (const name of ['config.json', 'known_hosts']) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      checkFileWritable(path);
    } catch {
      return { ok: false, file: path };
    }
  }

  // Sidecar-копии `<db>.backup-vN` (Data_Structures §3.6) — тоже данные.
  let sidecars: string[] = [];
  try {
    sidecars = readdirSync(dir).filter((n) => /^(?:hosts|history)\.db\.backup-v/.test(n));
  } catch {
    // каталог только что успешно проверен записью — сюда не дойдёт
  }
  for (const name of sidecars) {
    try {
      checkFileWritable(join(dir, name));
    } catch {
      return { ok: false, file: join(dir, name) };
    }
  }

  // Обе БД: реальная проба записи с откатом, включая WAL-режим.
  for (const name of ['hosts.db', 'history.db']) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      checkDbWritable(path);
    } catch {
      return { ok: false, file: path };
    }
  }

  const backupsDir = join(dir, 'backups');
  try {
    checkBackupsWritable(backupsDir);
  } catch {
    return { ok: false, file: backupsDir };
  }

  return { ok: true };
}
