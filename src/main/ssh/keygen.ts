import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { utils } from 'ssh2';
import type { KeygenGenerateRequest, KeygenGenerateResult, PendingKeyDeployment } from '@shared/keygen';
import { loadConfig, updateConfig } from '../config/store';
import type { Connection } from './connection';

/**
 * Мастер создания SSH-ключа (HM-12):
 * — генерация пары Ed25519 через системный `ssh-keygen` (SEC-04 — не
 *   собственная и не сторонняя криптография), файл `~/.ssh/id_ed25519_<slug>`;
 * — реестр «публичный ключ ждёт дозаписи на сервер»: заполняется при
 *   генерации (идентификатор — keyPath, см. PendingKeyDeployment), срабатывает
 *   после первого успешного пароль-логина к хосту с этим keyPath (sessionManager
 *   зовёт deployPendingKey на 'ready');
 * — дозапись в `~/.ssh/authorized_keys` через exec-канал того же типа, что у
 *   дашборда (не основная сессия), с дедупликацией по содержимому строки.
 */

const EXEC_FILE_TIMEOUT_MS = 20_000;
const DEPLOY_EXEC_TIMEOUT_MS = 10_000;
const MAX_AUTHORIZED_KEYS_READ = 1_000_000;

// --- Генерация пары -------------------------------------------------------

/**
 * Slug имени файла ключа: из имени хоста, если оно введено, иначе из
 * `user_host`. Санитизация под имя файла; коллизия двух хостов с одинаковым
 * slug сознательно не обрабатывается (решение сессии 2026-07-21).
 */
export function keyFileSlug(name: string, username: string, address: string): string {
  const source = name.trim().length > 0 ? name : `${username}_${address}`;
  const slug = source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '')
    .slice(0, 40);
  return slug.length > 0 ? slug : 'key';
}

function execFileP(
  file: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: EXEC_FILE_TIMEOUT_MS, env }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout });
    });
  });
}

/**
 * Где искать ssh-keygen: на Windows сначала компонент «Клиент OpenSSH», затем
 * PATH. Только абсолютные каталоги: пустой элемент PATH в POSIX — это текущий
 * каталог, и подложенный туда бинарь получил бы ключ и passphrase.
 */
export function sshKeygenCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const isWindows = platform === 'win32';
  const { delimiter, isAbsolute, join: joinPath } = isWindows ? win32 : posix;
  const fromPath = (env['PATH'] ?? '')
    .split(delimiter)
    .filter((dir) => isAbsolute(dir))
    .map((dir) => joinPath(dir, isWindows ? 'ssh-keygen.exe' : 'ssh-keygen'));
  if (!isWindows) return fromPath;
  const systemRoot = env['SystemRoot'] ?? 'C:\\Windows';
  return [joinPath(systemRoot, 'System32', 'OpenSSH', 'ssh-keygen.exe'), ...fromPath];
}

/** Путь к системному ssh-keygen или null, если его нет. */
export function findSshKeygen(): string | null {
  return sshKeygenCandidates(process.platform, process.env).find((p) => existsSync(p)) ?? null;
}

/**
 * Строка публичного ключа безопасна для однокавычечной вставки в shell-команду
 * дозаписи: только ожидаемые для `ssh-ed25519 <base64> [comment]` символы,
 * без кавычек и управляющих. Комментарий формируем сами (-C), но файл читается
 * с диска — проверяем результат, а не намерение.
 */
export function isSafePublicKeyLine(line: string): boolean {
  if (!line.startsWith('ssh-ed25519 ')) return false;
  return /^[A-Za-z0-9+/=@ ._:-]+$/.test(line);
}

/** Ключи, созданные мастером в этом запуске: только к ним разрешён
 *  keygenSetPassphrase — renderer не может натравить ssh-keygen -p
 *  на произвольный файл. */
const generatedThisRun = new Set<string>();

export async function generateKeyPair(req: KeygenGenerateRequest): Promise<KeygenGenerateResult> {
  const bin = findSshKeygen();
  if (!bin) return { ok: false, reason: 'keygen-missing' };

  const sshDir = join(homedir(), '.ssh');
  const keyPath = join(sshDir, `id_ed25519_${keyFileSlug(req.name, req.username, req.address)}`);
  // Кнопка мастера видна только когда файла по пути формы нет; совпадение slug
  // с уже существующим ключом — вне скоупа. Не перезаписываем чужой файл
  // (и не даём ssh-keygen повиснуть на вопросе «Overwrite?»).
  if (existsSync(keyPath) || existsSync(`${keyPath}.pub`)) {
    return { ok: false, reason: 'failed' };
  }

  const comment = `${sanitizeComment(req.username)}@${sanitizeComment(req.address)}`;
  try {
    mkdirSync(sshDir, { recursive: true });
    // Шаг 1 всегда без passphrase — она добавляется на шаге 2 (applyPassphrase),
    // чтобы закрытие мастера после шага 1 оставляло рабочий ключ.
    await execFileP(bin, ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', keyPath]);
  } catch {
    return { ok: false, reason: 'failed' };
  }

  let publicKey: string;
  try {
    publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim();
  } catch {
    return { ok: false, reason: 'failed' };
  }
  if (!isSafePublicKeyLine(publicKey)) return { ok: false, reason: 'failed' };

  generatedThisRun.add(keyPath);
  registerPendingDeployment({ keyPath, publicKey });
  return { ok: true, keyPath, publicKey };
}

function sanitizeComment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64);
}

/** askpass-хелпер: печатает passphrase из своего окружения. Delayed expansion
 *  (`!VAR!`) не разбирает значение повторно — `& | < > ^ % "` выводятся как есть;
 *  `echo(` — чтобы значение вида `/?` не стало ключом echo. */
const ASKPASS_VAR = 'LUCIDSSH_ASKPASS';
const ASKPASS_CMD = `@echo off\r\nsetlocal EnableDelayedExpansion\r\necho(!${ASKPASS_VAR}!\r\n`;
/** POSIX-вариант: `printf '%s\n'` выводит значение как есть, в отличие от `echo`. */
const ASKPASS_SH = `#!/bin/sh\nprintf '%s\\n' "$${ASKPASS_VAR}"\n`;
/** Ответ askpass ssh-keygen читает в буфер 1024 байта: длиннее — молча обрежет,
 *  и сохранённая полная passphrase ключ не откроет. */
const ASKPASS_MAX_BYTES = 1023;

/** Пишет askpass-хелпер платформы в `dir`, возвращает его путь. Секрета в файле нет. */
export function writeAskpass(dir: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const file = join(dir, 'askpass.cmd');
    writeFileSync(file, ASKPASS_CMD);
    return file;
  }
  const file = join(dir, 'askpass.sh');
  writeFileSync(file, ASKPASS_SH, { mode: 0o700 });
  return file;
}

/**
 * Шаг 2 мастера: навесить passphrase на только что созданный ключ (была пустая).
 * Не через `-N <passphrase>`: командная строка процесса видна любому процессу
 * пользователя и пишется аудитом (Event 4688, Sysmon, EDR). ssh-keygen сам
 * спрашивает новую passphrase (дважды) у SSH_ASKPASS, а тот берёт её из
 * унаследованного окружения — в argv ни ssh-keygen, ни хелпера её нет.
 * Проверено на OpenSSH_for_Windows 9.5p1 и OpenSSH 9.6p1 (Ubuntu 24.04);
 * SSH_ASKPASS_REQUIRE — с OpenSSH 8.4.
 */
export async function applyPassphrase(keyPath: string, passphrase: string): Promise<boolean> {
  if (!generatedThisRun.has(keyPath)) return false;
  if (Buffer.byteLength(passphrase, 'utf8') > ASKPASS_MAX_BYTES) return false;
  const bin = findSshKeygen();
  if (!bin) return false;
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'lucidssh-askpass-'));
    const askpass = writeAskpass(dir, process.platform);
    await execFileP(bin, ['-q', '-p', '-P', '', '-f', keyPath], {
      ...process.env,
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: 'force',
      [ASKPASS_VAR]: passphrase
    });
    // Код 0 не доказывает защиту: askpass, который не запустился (noexec /tmp,
    // антивирус), ssh-keygen принимает за пустую passphrase и пишет ключ как был.
    return utils.parseKey(readFileSync(keyPath)) instanceof Error;
  } catch {
    return false;
  } finally {
    // Ключ уже зашифрован — неудача уборки (антивирус держит .cmd) не должна
    // превращать успех в отказ; в скрипте нет секрета, остаток во временном каталоге безвреден.
    try {
      if (dir) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* см. выше */
    }
  }
}

// --- Реестр «ключ ждёт дозаписи на сервер» --------------------------------

/**
 * Хранится в config.json (не в памяти процесса): реальный пользователь вполне
 * может закрыть LucidSSH между мастером и первым входом по паролю — если бы
 * реестр жил только в памяти, такое подключение уходило бы напрямую по ключу
 * (которого ещё нет на сервере) и сразу проваливало аутентификацию, минуя
 * весь смысл шага 4 мастера. Идентификатор записи — keyPath (см.
 * PendingKeyDeployment): стабилен при правке адреса/пользователя в форме.
 */
export function registerPendingDeployment(d: PendingKeyDeployment): void {
  updateConfig((cfg) => {
    cfg.pendingKeyDeployments = cfg.pendingKeyDeployments.filter((e) => e.keyPath !== d.keyPath);
    cfg.pendingKeyDeployments.push(d);
  });
}

export function hasPendingDeployment(keyPath: string): boolean {
  return loadConfig().pendingKeyDeployments.some((e) => e.keyPath === keyPath);
}

function findPendingDeployment(keyPath: string): PendingKeyDeployment | undefined {
  return loadConfig().pendingKeyDeployments.find((e) => e.keyPath === keyPath);
}

/** Экспортируется и для удаления хоста (ipc/hosts.ts) — незачем хранить
 *  публичный ключ хоста, который пользователь только что удалил. */
export function clearPendingDeployment(keyPath: string): void {
  updateConfig((cfg) => {
    cfg.pendingKeyDeployments = cfg.pendingKeyDeployments.filter((e) => e.keyPath !== keyPath);
  });
}

/** Тестовый рычаг: сброс реестра между кейсами (config подменяется моком). */
export function __clearPendingDeploymentsForTest(): void {
  updateConfig((cfg) => {
    cfg.pendingKeyDeployments = [];
  });
}

// --- Дозапись в authorized_keys (шаг 4) -----------------------------------

/** Есть ли этот публичный ключ среди строк authorized_keys (дедупликация —
 *  сравнение по содержимому строки, пробелы нормализуются). */
export function authorizedKeysContains(fileContent: string, publicKeyLine: string): boolean {
  const normalize = (s: string): string => s.trim().replace(/\s+/g, ' ');
  const wanted = normalize(publicKeyLine);
  if (wanted.length === 0) return false;
  return fileContent.split(/\r?\n/).some((line) => normalize(line) === wanted);
}

/** Подготовка ~/.ssh (700) и authorized_keys (600, только если файла не было)
 *  + чтение текущего содержимого одним exec-вызовом. Статическая строка,
 *  недоверенного ввода не содержит (§19 гайда). */
export const AUTHORIZED_KEYS_SETUP_AND_READ =
  'mkdir -p ~/.ssh && chmod 700 ~/.ssh && ' +
  'if [ ! -f ~/.ssh/authorized_keys ]; then touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys; fi && ' +
  'cat ~/.ssh/authorized_keys';

/** Команда дозаписи. Ключ проверен isSafePublicKeyLine при генерации —
 *  однокавычечная вставка безопасна (кавычек и управляющих в строке нет). */
export function buildAppendCommand(publicKeyLine: string): string {
  return `printf '%s\n' '${publicKeyLine}' >> ~/.ssh/authorized_keys`;
}

function execOnClient(
  client: Pick<Connection, 'exec'>,
  command: string
): Promise<{ exitCode: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let exitCode: number | null = null;
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ exitCode, stdout });
    };
    const timer = setTimeout(() => finish(new Error('exec timeout')), DEPLOY_EXEC_TIMEOUT_MS);
    client.exec(command, (err, stream) => {
      if (err) {
        finish(err);
        return;
      }
      stream.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
        if (stdout.length > MAX_AUTHORIZED_KEYS_READ) stream.close();
      });
      stream.on('exit', (code: number | null) => {
        exitCode = code;
      });
      stream.on('close', () => finish());
      stream.stderr?.on('data', () => {
        /* только чтобы канал не копил backpressure; для решения не нужен */
      });
    });
  });
}

export type DeployLogger = (level: 'info' | 'warn', messageKey: string) => void;

/**
 * Дозапись ожидающего публичного ключа после успешного пароль-логина.
 * Ключ записи — keyPath хоста; клиент уже подключён к нужному серверу, поэтому
 * адрес/порт для самой дозаписи не нужны. Молчаливый no-op, если для этого
 * keyPath ничего не ждёт. При неудаче запись остаётся в реестре — попробуем
 * при следующем пароль-логине.
 */
export async function deployPendingKey(
  client: Pick<Connection, 'exec'>,
  keyPath: string,
  log: DeployLogger
): Promise<void> {
  const entry = findPendingDeployment(keyPath);
  if (!entry) return;
  try {
    const read = await execOnClient(client, AUTHORIZED_KEYS_SETUP_AND_READ);
    if (read.exitCode !== 0) {
      log('warn', 'clog.keyDeployFailed');
      return;
    }
    if (authorizedKeysContains(read.stdout, entry.publicKey)) {
      clearPendingDeployment(keyPath);
      log('info', 'clog.keyDeployExists');
      return;
    }
    const append = await execOnClient(client, buildAppendCommand(entry.publicKey));
    if (append.exitCode !== 0) {
      log('warn', 'clog.keyDeployFailed');
      return;
    }
    clearPendingDeployment(keyPath);
    log('info', 'clog.keyDeployed');
  } catch {
    log('warn', 'clog.keyDeployFailed');
  }
}
