import { dialog, ipcMain, shell } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { IPC } from '@shared/ipc';
import type { Host, HostGroup, ImportPreview } from '@shared/hosts';
import * as repo from '../hosts/repository';
import * as keychain from '../keychain';
import { keyFileExists } from '../hosts/keyFile';
import { applyPassphrase, clearPendingDeployment, findSshKeygen, generateKeyPair } from '../ssh/keygen';
import { PASSPHRASE_MIN, type KeygenGenerateRequest, type KeygenGenerateResult } from '@shared/keygen';
import {
  validateGroupName,
  validateHostInput,
  validateId,
  validateSecret
} from '../hosts/validate';
import {
  buildExport,
  ImportFormatError,
  importHosts,
  previewImport
} from '../hosts/exportImport';
import { countPuttySessions } from '../hosts/puttyDetect';
import { importPuttyPreview } from '../hosts/puttyImport';
import { importSshConfigPreview } from '../hosts/sshConfigImport';
import { importWinScpRegistryPreview, importWinScpIniPreview } from '../hosts/winscpImport';
import { applyExternalImport } from '../hosts/externalImport';
import type { ExternalImportApplyResult, ExternalImportResult, ImportedHost } from '@shared/import';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getMainWindow } from '../window/mainWindow';
import { updateConfig } from '../config/store';
import { assertSenderIsMainWindow, IpcValidationError } from './validate';
import { t } from '../i18n';

/**
 * IPC хостов/групп (HM-01…HM-06, EXP-01…04). Один канал — одна операция.
 * Секрет приходит отдельным аргументом, сразу уходит в keychain и
 * не возвращается обратно (SEC-01, §9–10 гайда).
 */

/**
 * Результат `hosts:delete` (SSH-05 тикет 05). Без `force` удаление хоста,
 * используемого как jump-хост у других, не проходит — вместо этого
 * возвращается список задетых хостов для предупреждения в renderer.
 */
type HostDeleteResult = { deleted: true } | { deleted: false; dependents: Host[] };

export function registerHostIpcHandlers(): void {
  // --- Хосты ---
  ipcMain.handle(IPC.hostsList, (event): Host[] => {
    assertSenderIsMainWindow(event);
    return repo.listHosts();
  });

  ipcMain.handle(IPC.hostsReorder, (event, rawIds: unknown): void => {
    assertSenderIsMainWindow(event);
    if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 1000) {
      throw new IpcValidationError('orderedIds: non-empty array expected');
    }
    const ids = rawIds.map((id) => validateId(id, 'orderedIds[]'));
    // Все id должны существовать и принадлежать одной группе — иначе можно
    // было бы переносить хосты между группами в обход createHost/updateHost.
    const found = ids.map((id) => repo.getHost(id));
    if (found.some((h) => h === null)) throw new IpcValidationError('orderedIds: host not found');
    const groupIds = new Set(found.map((h) => h!.groupId ?? null));
    if (groupIds.size > 1) throw new IpcValidationError('orderedIds: hosts span multiple groups');
    repo.reorderHosts(ids);
  });

  ipcMain.handle(IPC.groupsList, (event): HostGroup[] => {
    assertSenderIsMainWindow(event);
    return repo.listGroups();
  });

  ipcMain.handle(
    IPC.hostCreate,
    async (event, rawInput: unknown, rawSecret: unknown): Promise<{ id: number }> => {
      assertSenderIsMainWindow(event);
      const input = validateHostInput(rawInput);
      const secret = validateSecret(rawSecret);
      if (input.groupId !== undefined && !repo.groupExists(input.groupId)) {
        throw new IpcValidationError('groupId: group not found');
      }
      if (input.proxyJumpHostId !== undefined) {
        const rejection = repo.checkJumpHost(input.proxyJumpHostId);
        if (rejection) throw new IpcValidationError(`proxyJumpHostId: ${rejection}`);
      }
      const id = repo.createHost(input);
      if (secret !== undefined) await keychain.setSecret(id, secret);
      return { id };
    }
  );

  ipcMain.handle(
    IPC.hostUpdate,
    async (event, rawId: unknown, rawInput: unknown, rawSecret: unknown): Promise<void> => {
      assertSenderIsMainWindow(event);
      const id = validateId(rawId, 'hostId');
      const input = validateHostInput(rawInput);
      const secret = validateSecret(rawSecret);
      if (!repo.getHost(id)) throw new IpcValidationError('hostId: not found');
      if (input.groupId !== undefined && !repo.groupExists(input.groupId)) {
        throw new IpcValidationError('groupId: group not found');
      }
      if (input.proxyJumpHostId !== undefined) {
        const rejection = repo.checkJumpHost(input.proxyJumpHostId, id);
        if (rejection) throw new IpcValidationError(`proxyJumpHostId: ${rejection}`);
      }
      repo.updateHost(id, input);
      if (secret !== undefined) await keychain.setSecret(id, secret);
    }
  );

  ipcMain.handle(
    IPC.hostDelete,
    async (event, rawId: unknown, rawForce: unknown): Promise<HostDeleteResult> => {
      assertSenderIsMainWindow(event);
      const id = validateId(rawId, 'hostId');
      const force = rawForce === true;
      // SSH-05 тикет 05: хост используется как jump-хост у других — без force
      // удаление не проходит, renderer получает список и показывает предупреждение.
      // Проверка — в самом хендлере, а не только в renderer, чтобы предупреждение
      // нельзя было обойти прямым вызовом канала.
      if (!force) {
        const dependents = repo.listHostsReferencingProxyJump(id);
        if (dependents.length > 0) return { deleted: false, dependents };
      }
      const host = repo.getHost(id);
      repo.deleteHost(id);
      // Секрет удаляется вместе с хостом (§10 гайда)
      await keychain.deleteSecret(id);
      updateConfig((cfg) => {
        cfg.history.perHostDisabled = cfg.history.perHostDisabled.filter((h) => h !== id);
      });
      // HM-12: незачем хранить в config.json ожидающий ключ удалённого хоста
      if (host?.keyPath) clearPendingDeployment(host.keyPath);
      return { deleted: true };
    }
  );

  ipcMain.handle(IPC.hostHasSecret, async (event, rawId: unknown): Promise<boolean> => {
    assertSenderIsMainWindow(event);
    const id = validateId(rawId, 'hostId');
    // Только факт наличия — само значение никогда не покидает main (SEC-01)
    return keychain.hasSecret(id);
  });

  ipcMain.handle(IPC.hostDeleteSecret, async (event, rawId: unknown): Promise<void> => {
    assertSenderIsMainWindow(event);
    const id = validateId(rawId, 'hostId');
    await keychain.deleteSecret(id);
  });

  ipcMain.handle(IPC.hostPickKeyFile, async (event): Promise<string | null> => {
    assertSenderIsMainWindow(event);
    const win = getMainWindow();
    if (!win) return null;
    // Возвращается только путь к оригиналу — файл не читается и не копируется (SEC-02)
    const res = await dialog.showOpenDialog(win, {
      title: t('conn.keyPath'),
      properties: ['openFile', 'showHiddenFiles']
    });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.hostKeyFileExists, (event, rawPath: unknown): boolean => {
    assertSenderIsMainWindow(event);
    if (typeof rawPath !== 'string' || rawPath.length > 500) {
      throw new IpcValidationError('keyPath: string expected');
    }
    return keyFileExists(rawPath);
  });

  // --- Мастер создания SSH-ключа (HM-12) ---
  ipcMain.handle(IPC.keygenAvailable, async (event): Promise<boolean> => {
    assertSenderIsMainWindow(event);
    return (await findSshKeygen()) !== null;
  });

  ipcMain.handle(
    IPC.keygenGenerate,
    (event, raw: unknown): Promise<KeygenGenerateResult> => {
      assertSenderIsMainWindow(event);
      return generateKeyPair(validateKeygenRequest(raw));
    }
  );

  ipcMain.handle(
    IPC.keygenSetPassphrase,
    async (event, rawPath: unknown, rawPass: unknown): Promise<{ ok: boolean }> => {
      assertSenderIsMainWindow(event);
      if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > 500) {
        throw new IpcValidationError('keyPath: string expected');
      }
      // Минимум PASSPHRASE_MIN символов — ограничение самого ssh-keygen
      if (typeof rawPass !== 'string' || rawPass.length < PASSPHRASE_MIN || rawPass.length > 1024) {
        throw new IpcValidationError('passphrase: invalid');
      }
      // applyPassphrase дополнительно принимает только пути, созданные мастером
      // в этом запуске — произвольный файл через этот канал не трогается.
      return { ok: await applyPassphrase(rawPath, rawPass) };
    }
  );

  // Захардкоженный deep-link на компоненты Windows (§22 гайда — внешние
  // ссылки только на заранее определённые адреса).
  ipcMain.on(IPC.keygenOpenInstall, (event) => {
    assertSenderIsMainWindow(event);
    void shell.openExternal('ms-settings:optionalfeatures');
  });

  // --- Группы ---
  ipcMain.handle(IPC.groupCreate, (event, rawName: unknown): { id: number } => {
    assertSenderIsMainWindow(event);
    const name = validateGroupName(rawName);
    return { id: repo.createGroup(name) };
  });

  ipcMain.handle(IPC.groupRename, (event, rawId: unknown, rawName: unknown): void => {
    assertSenderIsMainWindow(event);
    const id = validateId(rawId, 'groupId');
    const name = validateGroupName(rawName);
    repo.renameGroup(id, name);
  });

  ipcMain.handle(IPC.groupSetCollapsed, (event, rawId: unknown, rawCollapsed: unknown): void => {
    assertSenderIsMainWindow(event);
    const id = validateId(rawId, 'groupId');
    if (typeof rawCollapsed !== 'boolean') {
      throw new IpcValidationError('collapsed: boolean expected');
    }
    repo.setGroupCollapsed(id, rawCollapsed);
  });

  ipcMain.handle(IPC.groupDelete, (event, rawId: unknown): void => {
    assertSenderIsMainWindow(event);
    const id = validateId(rawId, 'groupId');
    repo.deleteGroup(id);
  });

  // --- Экспорт / импорт (EXP-01…04) ---
  ipcMain.handle(IPC.hostsExport, async (event): Promise<{ saved: boolean }> => {
    assertSenderIsMainWindow(event);
    const win = getMainWindow();
    if (!win) return { saved: false };
    const res = await dialog.showSaveDialog(win, {
      title: t('hosts.export.dialogTitle'),
      defaultPath: 'lucidssh-hosts.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return { saved: false };
    const data = buildExport(repo.listHosts(), repo.listGroups());
    await writeFile(res.filePath, JSON.stringify(data, null, 2), 'utf8');
    return { saved: true };
  });

  ipcMain.handle(
    IPC.hostsImportPick,
    async (event): Promise<{ json: string; preview: ImportPreview } | null> => {
      assertSenderIsMainWindow(event);
      const win = getMainWindow();
      if (!win) return null;
      const res = await dialog.showOpenDialog(win, {
        title: t('hosts.import.dialogTitle'),
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile']
      });
      const file = res.filePaths[0];
      if (res.canceled || !file) return null;
      const json = await readFile(file, 'utf8');
      try {
        return { json, preview: previewImport(json) };
      } catch (err) {
        if (err instanceof ImportFormatError || err instanceof IpcValidationError) {
          // Некорректный файл отклоняется с понятным сообщением (EXP-04)
          throw new Error(t('hosts.import.invalidFile'), { cause: err });
        }
        throw err;
      }
    }
  );

  ipcMain.handle(
    IPC.hostsImportApply,
    (event, rawJson: unknown, rawStrategy: unknown): { imported: number; skipped: number } => {
      assertSenderIsMainWindow(event);
      if (typeof rawJson !== 'string' || rawJson.length > 5_000_000) {
        throw new IpcValidationError('json: invalid');
      }
      if (rawStrategy !== 'skip' && rawStrategy !== 'rename') {
        throw new IpcValidationError('strategy: skip|rename expected');
      }
      try {
        return importHosts(rawJson, rawStrategy);
      } catch (err) {
        if (err instanceof ImportFormatError || err instanceof IpcValidationError) {
          throw new Error(t('hosts.import.invalidFile'), { cause: err });
        }
        throw err;
      }
    }
  );

  // --- Импорт из внешних источников (HM-03 PuTTY, HM-04 ssh_config, HM-10 WinSCP) ---
  ipcMain.handle(IPC.importPuttyPreview, (event): Promise<ExternalImportResult> => {
    assertSenderIsMainWindow(event);
    return importPuttyPreview();
  });

  ipcMain.handle(
    IPC.importSshConfigPreview,
    async (event): Promise<ExternalImportResult | null> => {
      assertSenderIsMainWindow(event);
      const win = getMainWindow();
      if (!win) return null;
      // Файл выбирается пользователем; по умолчанию ~/.ssh/config
      const res = await dialog.showOpenDialog(win, {
        title: t('import.ssh.pickTitle'),
        defaultPath: join(homedir(), '.ssh', 'config'),
        properties: ['openFile', 'showHiddenFiles']
      });
      const file = res.filePaths[0];
      if (res.canceled || !file) return null;
      // Файл — недоверенные данные: только читается и разбирается (§12 гайда)
      return importSshConfigPreview(file);
    }
  );

  ipcMain.handle(IPC.importWinScpPreview, (event): Promise<ExternalImportResult> => {
    assertSenderIsMainWindow(event);
    return importWinScpRegistryPreview();
  });

  ipcMain.handle(
    IPC.importWinScpIniPreview,
    async (event): Promise<ExternalImportResult | null> => {
      assertSenderIsMainWindow(event);
      const win = getMainWindow();
      if (!win) return null;
      const res = await dialog.showOpenDialog(win, {
        title: t('import.winscp.pickTitle'),
        filters: [{ name: 'INI', extensions: ['ini'] }],
        properties: ['openFile']
      });
      const file = res.filePaths[0];
      if (res.canceled || !file) return null;
      // Файл — недоверенные данные: только читается и разбирается (§12 гайда)
      return importWinScpIniPreview(file);
    }
  );

  ipcMain.handle(
    IPC.importExternalApply,
    (event, rawHosts: unknown, rawStrategy: unknown): ExternalImportApplyResult => {
      assertSenderIsMainWindow(event);
      if (rawStrategy !== 'skip' && rawStrategy !== 'rename') {
        throw new IpcValidationError('strategy: skip|rename expected');
      }
      const hosts = validateImportedHosts(rawHosts);
      return applyExternalImport(hosts, rawStrategy);
    }
  );

  // --- Onboarding (OB-01, OB-03) ---
  ipcMain.handle(IPC.puttySessionsCount, (event): Promise<number> => {
    assertSenderIsMainWindow(event);
    return countPuttySessions();
  });
}

/** Валидация запроса генерации ключа (HM-12): поля формы хоста могут быть
 *  ещё не заполнены (пустое имя/адрес допустимы — slug возьмётся из остатка). */
function validateKeygenRequest(raw: unknown): KeygenGenerateRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new IpcValidationError('keygenRequest: object expected');
  }
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, name: string, maxLen: number): string => {
    if (typeof v !== 'string' || v.length > maxLen) {
      throw new IpcValidationError(`${name}: string expected`);
    }
    return v.trim();
  };
  const port = r['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new IpcValidationError('port: 1..65535 expected');
  }
  return {
    name: str(r['name'], 'name', 100),
    address: str(r['address'], 'address', 255),
    port,
    username: str(r['username'], 'username', 64)
  };
}

/**
 * Валидация массива ImportedHost, пришедшего из renderer при применении импорта.
 * Проверяем только базовую форму; строгую проверку каждого поля делает
 * applyExternalImport через validateHostInput (недоверенные данные, §12 гайда).
 */
function validateImportedHosts(raw: unknown): ImportedHost[] {
  if (!Array.isArray(raw) || raw.length > 10_000) {
    throw new IpcValidationError('hosts: array expected');
  }
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length <= 500 ? v : undefined;
  return raw.map((item): ImportedHost => {
    if (typeof item !== 'object' || item === null) {
      throw new IpcValidationError('host: object expected');
    }
    const r = item as Record<string, unknown>;
    return {
      name: str(r['name']) ?? '',
      address: str(r['address']) ?? '',
      port: typeof r['port'] === 'number' ? r['port'] : 22,
      username: str(r['username']) ?? '',
      authMethod: r['authMethod'] === 'key' ? 'key' : 'password',
      keyPath: str(r['keyPath']),
      proxyJump: str(r['proxyJump']),
      note: str(r['note'])
    };
  });
}
