import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { utils } from 'ssh2';
import type { PendingKeyDeployment } from '@shared/keygen';

// keygen.ts персистирует «ожидающие дозаписи» ключи в config.json (переживает
// перезапуск приложения — реальный пользователь может закрыть LucidSSH между
// мастером и первым входом по паролю), поэтому config/store мокается тем же
// приёмом, что и в sessionManager.test.ts: фальшивое хранилище в замыкании
// фабрики, без реального fs/Electron.
vi.mock('../config/store', () => {
  const state = { pendingKeyDeployments: [] as PendingKeyDeployment[] };
  return {
    __state: state,
    loadConfig: () => state,
    updateConfig: (mutator: (cfg: typeof state) => void) => {
      mutator(state);
      return state;
    }
  };
});

// Мастер пишет ключ в ~/.ssh — в тесте домашняя папка подменяется временной.
// execFile обёрнут шпионом (поведение настоящее): по нему проверяется, что
// passphrase не попадает в аргументы дочерних процессов.
const fakeHome = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'lucidssh-keygen-test-'));
});
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, homedir: () => fakeHome };
});
vi.mock('node:child_process', async (importOriginal) => {
  const cp = await importOriginal<typeof import('node:child_process')>();
  return { ...cp, execFile: vi.fn(cp.execFile) };
});

import { execFile, type ChildProcess, type ExecFileOptions } from 'node:child_process';
import {
  __clearPendingDeploymentsForTest,
  applyPassphrase,
  authorizedKeysContains,
  buildAppendCommand,
  findSshKeygen,
  generateKeyPair,
  hasPendingDeployment,
  isSafePublicKeyLine,
  keyFileSlug,
  registerPendingDeployment,
  sshKeygenCandidates,
  writeAskpass
} from './keygen';

/** Тесты HM-12: логика вокруг реальных системных вызовов (ssh-keygen и
 *  exec-канал живой проверкой не покрываются) — slug имени файла, валидация
 *  строки публичного ключа, дедупликация в authorized_keys, реестр ожидающих
 *  дозаписей (Testing Decisions спеки release-1.0-remaining-features). */

const KEY_LINE =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFa2ke1vYtOWma8XPeCBAbcXAdmYRWFRW21NRBFukhsJ deploy@example.com';

describe('keyFileSlug', () => {
  it('берёт slug из имени хоста, если оно введено', () => {
    expect(keyFileSlug('Мой сервер VPS-1', 'root', '203.0.113.5')).toBe('vps-1');
  });

  it('латинское имя санитизируется и приводится к нижнему регистру', () => {
    expect(keyFileSlug('Prod Server #2', 'root', 'example.com')).toBe('prod_server_2');
  });

  it('без имени — из пользователя и адреса', () => {
    expect(keyFileSlug('', 'deploy', 'example.com')).toBe('deploy_example.com');
    expect(keyFileSlug('   ', 'root', '203.0.113.5')).toBe('root_203.0.113.5');
  });

  it('пустой результат санитизации заменяется на key', () => {
    expect(keyFileSlug('Сервер', '', '')).toBe('key');
    expect(keyFileSlug('', '', '')).toBe('key');
  });

  it('обрезается до 40 символов', () => {
    expect(keyFileSlug('a'.repeat(80), 'u', 'h').length).toBeLessThanOrEqual(40);
  });
});

describe('isSafePublicKeyLine', () => {
  it('принимает нормальную строку ed25519 с комментарием', () => {
    expect(isSafePublicKeyLine(KEY_LINE)).toBe(true);
  });

  it('принимает строку без комментария', () => {
    expect(isSafePublicKeyLine('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFa2ke1vYtOW')).toBe(true);
  });

  it('отклоняет другой тип ключа', () => {
    expect(isSafePublicKeyLine('ssh-rsa AAAAB3NzaC1yc2E comment')).toBe(false);
  });

  it('отклоняет кавычки, перевод строки и прочие опасные символы', () => {
    expect(isSafePublicKeyLine("ssh-ed25519 AAAA' ; rm -rf /")).toBe(false);
    expect(isSafePublicKeyLine('ssh-ed25519 AAAA\nssh-ed25519 BBBB')).toBe(false);
    expect(isSafePublicKeyLine('ssh-ed25519 AAAA `id`')).toBe(false);
  });
});

describe('authorizedKeysContains', () => {
  it('находит ключ среди других строк', () => {
    const file = `ssh-rsa AAAABBBB old@pc\n${KEY_LINE}\nssh-ed25519 CCCC other@pc\n`;
    expect(authorizedKeysContains(file, KEY_LINE)).toBe(true);
  });

  it('не находит отсутствующий ключ (в т.ч. с другим комментарием)', () => {
    const other = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFa2ke1vYtOWma8XPeCBAbcXAdmYRWFRW21NRBFukhsJ another@pc';
    expect(authorizedKeysContains(other, KEY_LINE)).toBe(false);
    expect(authorizedKeysContains('', KEY_LINE)).toBe(false);
  });

  it('терпит CRLF, хвостовые пробелы и лишние пробелы между полями', () => {
    const file = `# comment\r\n  ${KEY_LINE.replace(' ', '   ')}  \r\n`;
    expect(authorizedKeysContains(file, KEY_LINE)).toBe(true);
  });

  it('пустая искомая строка не совпадает с пустыми строками файла', () => {
    expect(authorizedKeysContains('\n\n', '')).toBe(false);
  });
});

describe('buildAppendCommand', () => {
  it('оборачивает ключ в одинарные кавычки и дописывает в authorized_keys', () => {
    expect(buildAppendCommand(KEY_LINE)).toBe(
      `printf '%s\n' '${KEY_LINE}' >> ~/.ssh/authorized_keys`
    );
  });
});

describe('реестр ожидающих дозаписей', () => {
  const KEY_PATH = 'C:\\Users\\u\\.ssh\\id_ed25519_web';

  afterEach(() => __clearPendingDeploymentsForTest());

  it('регистрация видна по keyPath', () => {
    registerPendingDeployment({ keyPath: KEY_PATH, publicKey: KEY_LINE });
    expect(hasPendingDeployment(KEY_PATH)).toBe(true);
    expect(hasPendingDeployment('C:\\Users\\u\\.ssh\\id_ed25519_other')).toBe(false);
  });

  it('повторная регистрация того же keyPath заменяет запись, а не дублирует её', async () => {
    registerPendingDeployment({ keyPath: KEY_PATH, publicKey: KEY_LINE });
    registerPendingDeployment({ keyPath: KEY_PATH, publicKey: 'ssh-ed25519 BBBB deploy@example.com' });
    const { __state } = (await import('../config/store')) as unknown as {
      __state: { pendingKeyDeployments: unknown[] };
    };
    expect(__state.pendingKeyDeployments).toHaveLength(1);
  });
});

describe('sshKeygenCandidates', () => {
  it('Windows: сначала компонент OpenSSH из SystemRoot, затем PATH с .exe', () => {
    expect(
      sshKeygenCandidates('win32', { SystemRoot: 'D:\\Win', PATH: 'C:\\Git\\bin;C:\\tools' })
    ).toEqual([
      'D:\\Win\\System32\\OpenSSH\\ssh-keygen.exe',
      'C:\\Git\\bin\\ssh-keygen.exe',
      'C:\\tools\\ssh-keygen.exe'
    ]);
  });

  it('Windows: без SystemRoot и PATH остаётся путь по умолчанию', () => {
    expect(sshKeygenCandidates('win32', {})).toEqual([
      'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe'
    ]);
  });

  it('Linux: по каталогам PATH, без .exe и без пути Windows', () => {
    expect(sshKeygenCandidates('linux', { PATH: '/usr/local/bin:/usr/bin' })).toEqual([
      '/usr/local/bin/ssh-keygen',
      '/usr/bin/ssh-keygen'
    ]);
  });

  it('Linux: пустой или отсутствующий PATH — кандидатов нет', () => {
    expect(sshKeygenCandidates('linux', {})).toEqual([]);
    expect(sshKeygenCandidates('linux', { PATH: '' })).toEqual([]);
  });

  // Пустой элемент PATH в POSIX означает текущий каталог: запуск оттуда подменил
  // бы ssh-keygen, через который идёт генерация ключа и passphrase.
  it('пустые и относительные элементы PATH отбрасываются', () => {
    expect(sshKeygenCandidates('linux', { PATH: ':.:bin:/usr/bin:' })).toEqual([
      '/usr/bin/ssh-keygen'
    ]);
    expect(sshKeygenCandidates('win32', { SystemRoot: 'D:\\Win', PATH: ';.;C:\\tools;' })).toEqual([
      'D:\\Win\\System32\\OpenSSH\\ssh-keygen.exe',
      'C:\\tools\\ssh-keygen.exe'
    ]);
  });
});

describe('writeAskpass', () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lucidssh-askpass-test-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('Linux: askpass.sh печатает значение из окружения, секрета в теле нет', () => {
    const file = writeAskpass(tempDir(), 'linux');
    expect(basename(file)).toBe('askpass.sh');
    expect(readFileSync(file, 'utf8')).toBe(`#!/bin/sh\nprintf '%s\\n' "$LUCIDSSH_ASKPASS"\n`);
  });

  it('Windows: askpass.cmd с delayed expansion', () => {
    const file = writeAskpass(tempDir(), 'win32');
    expect(basename(file)).toBe('askpass.cmd');
    expect(readFileSync(file, 'utf8')).toBe(
      '@echo off\r\nsetlocal EnableDelayedExpansion\r\necho(!LUCIDSSH_ASKPASS!\r\n'
    );
  });

  // ssh-keygen запускает askpass напрямую: без x-бита шаг passphrase провалится.
  it.skipIf(process.platform === 'win32')('Linux: права файла — 0700', () => {
    const file = writeAskpass(tempDir(), 'linux');
    expect(statSync(file).mode & 0o777).toBe(0o700);
  });
});

// Живой ssh-keygen + askpass текущей платформы; без ssh-keygen — пропуск.
const hasKeygen = findSshKeygen() !== null;

afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

describe.skipIf(!hasKeygen)('applyPassphrase (живой ssh-keygen)', () => {
  // Спецсимволы cmd и sh, пробелы по краям и не-ASCII: любая из них сломала бы
  // наивный `echo %VAR%`, `echo $VAR` или кодировку вывода.
  const PASSPHRASE = '  a&b|c<d>e^f %PATH% $HOME `id` \\n !x! "q" пароль 日本  ';

  it('passphrase не попадает в argv, ключ расшифровывается ею и только ею', async () => {
    const gen = await generateKeyPair({ name: 'pp-test', address: 'h', port: 22, username: 'u' });
    if (!gen.ok) throw new Error(`generateKeyPair: ${gen.reason}`);
    vi.mocked(execFile).mockClear();

    expect(await applyPassphrase(gen.keyPath, PASSPHRASE)).toBe(true);

    const argvs = vi.mocked(execFile).mock.calls.map((c) => JSON.stringify(c[1]));
    expect(argvs.length).toBeGreaterThan(0);
    for (const argv of argvs) expect(argv).not.toContain(JSON.stringify(PASSPHRASE).slice(1, -1));

    const pem = readFileSync(gen.keyPath);
    expect(utils.parseKey(pem, PASSPHRASE)).not.toBeInstanceOf(Error);
    expect(utils.parseKey(pem, 'wrong-pass')).toBeInstanceOf(Error);
    expect(utils.parseKey(pem)).toBeInstanceOf(Error);
  }, 30_000);

  // askpass читается в буфер 1024 байта: длиннее — ssh-keygen молча обрезал бы,
  // и сохранённая полная passphrase ключ бы не открывала.
  it('passphrase до 1023 байт UTF-8 проходит целиком, длиннее — отказ без изменения ключа', async () => {
    const fits = await generateKeyPair({ name: 'pp-1023', address: 'h', port: 22, username: 'u' });
    const tooLong = await generateKeyPair({ name: 'pp-1024', address: 'h', port: 22, username: 'u' });
    if (!fits.ok || !tooLong.ok) throw new Error('generateKeyPair failed');

    const max = 'я'.repeat(511) + 'z'; // 1023 байта
    expect(await applyPassphrase(fits.keyPath, max)).toBe(true);
    expect(utils.parseKey(readFileSync(fits.keyPath), max)).not.toBeInstanceOf(Error);

    expect(await applyPassphrase(tooLong.keyPath, 'я'.repeat(512))).toBe(false);
    expect(utils.parseKey(readFileSync(tooLong.keyPath))).not.toBeInstanceOf(Error);
  }, 30_000);

  // ssh-keygen принимает ответ несработавшего askpass за пустую passphrase и
  // выходит с кодом 0 (noexec /tmp, антивирус): мастер не должен сказать «защищён».
  it('askpass не запустился — отказ, хотя ssh-keygen завершился с кодом 0', async () => {
    const gen = await generateKeyPair({ name: 'pp-broken', address: 'h', port: 22, username: 'u' });
    if (!gen.ok) throw new Error(`generateKeyPair: ${gen.reason}`);
    const cp = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const brokenAskpass = (
      file: string,
      args: string[],
      opts: ExecFileOptions,
      cb: (err: Error | null, stdout: string, stderr: string) => void
    ): ChildProcess =>
      cp.execFile(
        file,
        args,
        { ...opts, encoding: 'utf8', env: { ...opts.env, SSH_ASKPASS: join(fakeHome, 'no-such-askpass') } },
        cb
      );
    vi.mocked(execFile).mockImplementationOnce(brokenAskpass as unknown as typeof execFile);

    expect(await applyPassphrase(gen.keyPath, PASSPHRASE)).toBe(false);
    expect(utils.parseKey(readFileSync(gen.keyPath))).not.toBeInstanceOf(Error);
  }, 30_000);

  it('без шага 2 ключ остаётся без passphrase', async () => {
    const gen = await generateKeyPair({ name: 'no-pp-test', address: 'h', port: 22, username: 'u' });
    if (!gen.ok) throw new Error(`generateKeyPair: ${gen.reason}`);
    expect(utils.parseKey(readFileSync(gen.keyPath))).not.toBeInstanceOf(Error);
  }, 30_000);
});
