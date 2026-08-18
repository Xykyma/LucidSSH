import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DangerPatternId, DangerScope } from '@shared/guard';

vi.mock('../ssh/sessionManager', () => ({
  getSession: vi.fn(),
  recordBlockedCommand: vi.fn(),
  sendCommandLine: vi.fn(),
  sendInput: vi.fn()
}));
vi.mock('../hosts/repository', () => ({ getHost: vi.fn() }));
vi.mock('../config/store', () => ({ loadConfig: vi.fn() }));
vi.mock('./patterns', () => ({ analyzeDangers: vi.fn(), analyzeAccessRisk: vi.fn() }));
vi.mock('../i18n', () => ({ t: vi.fn((key: string) => key) }));

import { getSession, recordBlockedCommand, sendCommandLine, sendInput } from '../ssh/sessionManager';
import { getHost } from '../hosts/repository';
import { loadConfig } from '../config/store';
import type { DangerMatch } from './patterns';
import { analyzeAccessRisk, analyzeDangers } from './patterns';
import { t } from '../i18n';
import {
  submitCommand,
  submitRawInput,
  confirmDangerousCommand,
  cancelDangerousCommand
} from './manager';

const mockGetSession = vi.mocked(getSession);
const mockRecordBlockedCommand = vi.mocked(recordBlockedCommand);
const mockSendCommandLine = vi.mocked(sendCommandLine);
const mockSendInput = vi.mocked(sendInput);
const mockGetHost = vi.mocked(getHost);
const mockLoadConfig = vi.mocked(loadConfig);
const mockAnalyzeDangers = vi.mocked(analyzeDangers);
const mockAnalyzeAccessRisk = vi.mocked(analyzeAccessRisk);
const mockT = vi.mocked(t);

// ManagedSession/Host/AppConfig не экспортированы из своих модулей (по дизайну) —
// в тестах нужны только использованные manager.ts поля, остальное подделываем
// через unknown-каст (не any — тот запрещён линтером).
const fakeSession = (hostId: number): ReturnType<typeof getSession> =>
  ({ hostId }) as unknown as ReturnType<typeof getSession>;
const fakeHost = (guardEnabled: boolean): ReturnType<typeof getHost> =>
  ({ guardEnabled }) as unknown as ReturnType<typeof getHost>;
const fakeConfig = (globalEnabled: boolean): ReturnType<typeof loadConfig> =>
  ({ guard: { globalEnabled } }) as unknown as ReturnType<typeof loadConfig>;

/**
 * Обязательное покрытие (CLAUDE.md §10): перехват в main до отправки на сервер,
 * GUARD-05 (вкл/выкл по хосту и глобально) — включая hostId=0 (HM-11 Quick
 * Connect, getHost возвращает null → Страж по умолчанию включён).
 */
describe('submitCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(fakeConfig(true));
    mockGetSession.mockReturnValue(fakeSession(1));
    mockGetHost.mockReturnValue(fakeHost(true));
    mockAnalyzeDangers.mockReturnValue([]);
    mockAnalyzeAccessRisk.mockReturnValue(null);
  });

  it('неизвестная сессия — команда не отправляется', () => {
    mockGetSession.mockReturnValue(undefined);
    const res = submitCommand('s1', 'ls');
    expect(res).toEqual({ status: 'sent' });
    expect(mockSendCommandLine).not.toHaveBeenCalled();
  });

  it('безопасная команда уходит на сервер с переводом строки', () => {
    const res = submitCommand('s1', 'ls -la');
    expect(res).toEqual({ status: 'sent' });
    expect(mockSendCommandLine).toHaveBeenCalledWith('s1', 'ls -la');
  });

  it('Страж выключен глобально — опасная команда всё равно уходит', () => {
    mockLoadConfig.mockReturnValue(fakeConfig(false));
    mockAnalyzeDangers.mockReturnValue([{
      patternId: 'rm-recursive',
      target: '/var/www',
      scope: 'directory',
      confirmationKind: 'target',
      confirmationText: 'www'
    }]);
    const res = submitCommand('s1', 'rm -rf /var/www');
    expect(res).toEqual({ status: 'sent' });
    expect(mockSendCommandLine).toHaveBeenCalled();
  });

  it('Страж выключен для конкретного хоста — команда уходит', () => {
    mockGetHost.mockReturnValue(fakeHost(false));
    mockAnalyzeDangers.mockReturnValue([{
      patternId: 'rm-recursive',
      target: '/var/www',
      scope: 'directory',
      confirmationKind: 'target',
      confirmationText: 'www'
    }]);
    const res = submitCommand('s1', 'rm -rf /var/www');
    expect(res.status).toBe('sent');
  });

  it('hostId=0 (Quick Connect, HM-11) — getHost(0)=null, Страж включён по умолчанию', () => {
    mockGetSession.mockReturnValue(fakeSession(0));
    mockGetHost.mockReturnValue(null);
    mockAnalyzeDangers.mockReturnValue([{
      patternId: 'rm-recursive',
      target: '/var/www',
      scope: 'directory',
      confirmationKind: 'target',
      confirmationText: 'www'
    }]);
    const res = submitCommand('s1', 'rm -rf /var/www');
    expect(res.status).toBe('blocked');
  });

  it('опасная команда (kind=target) блокируется, confirmationText — реальное имя объекта', () => {
    mockAnalyzeDangers.mockReturnValue([{
      patternId: 'rm-recursive',
      target: '/var/www',
      scope: 'directory',
      confirmationKind: 'target',
      confirmationText: 'www'
    }]);
    const res = submitCommand('s1', 'rm -rf /var/www');
    expect(res).toMatchObject({
      status: 'blocked',
      prompt: { confirmationKind: 'target', confirmationText: 'www', target: '/var/www' }
    });
    expect(mockSendCommandLine).not.toHaveBeenCalled();
    expect(mockT).not.toHaveBeenCalled();
  });

  it('опасная команда (kind=word) — confirmationText локализуется через t(), не сырое значение patterns.ts', () => {
    mockT.mockReturnValue('ПОДТВЕРЖДАЮ');
    mockAnalyzeDangers.mockReturnValue([{
      patternId: 'fork-bomb',
      target: ':(){ :|:& };:',
      scope: 'other',
      confirmationKind: 'word',
      confirmationText: 'INTERNAL_SENTINEL'
    }]);
    const res = submitCommand('s1', ':(){ :|:& };:');
    expect(mockT).toHaveBeenCalledWith('guard.confirmWord');
    expect(res).toMatchObject({ status: 'blocked', prompt: { confirmationText: 'ПОДТВЕРЖДАЮ' } });
  });
});

/**
 * Составная команда с несколькими опасными фрагментами
 * (.scratch/guard-multi-fragment-confirm/spec.md): показываем ВСЕ объекты,
 * набрать просим ОДИН — выбранный жребием среди самых тяжёлых.
 */
describe('submitCommand — несколько опасных фрагментов', () => {
  /** Совпадение с целью: подтверждается последним сегментом пути. */
  const hit = (target: string, scope: DangerScope = 'directory'): DangerMatch => ({
    patternId: 'rm-recursive',
    target,
    scope,
    confirmationKind: 'target',
    confirmationText: target.split('/').filter(Boolean).pop() ?? target
  });
  /** Совпадение без цели (форк-бомба, kill -9 1): подтверждается словом. */
  const wordHit = (patternId: DangerPatternId, whole: string): DangerMatch => ({
    patternId,
    target: whole,
    scope: 'other',
    confirmationKind: 'word',
    confirmationText: 'INTERNAL_SENTINEL'
  });

  function blockedPrompt(command: string): Extract<
    ReturnType<typeof submitCommand>,
    { status: 'blocked' }
  >['prompt'] {
    const res = submitCommand('s1', command);
    if (res.status !== 'blocked') throw new Error('expected blocked');
    return res.prompt;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(fakeConfig(true));
    mockGetSession.mockReturnValue(fakeSession(1));
    mockGetHost.mockReturnValue(fakeHost(true));
    mockT.mockImplementation((key: string) => key);
    mockAnalyzeAccessRisk.mockReturnValue(null);
  });

  it('в targets попадают все объекты, в порядке фрагментов', () => {
    mockAnalyzeDangers.mockReturnValue([hit('/var/www'), hit('/etc')]);
    const prompt = blockedPrompt('rm -rf /var/www && rm -rf /etc');
    expect(prompt.targets).toEqual(['/var/www', '/etc']);
  });

  it('один опасный фрагмент — ровно как раньше: тот же объект и тот же текст', () => {
    mockAnalyzeDangers.mockReturnValue([hit('/var/www')]);
    const prompt = blockedPrompt('rm -rf ./node_modules && npm install');
    expect(prompt).toMatchObject({
      patternId: 'rm-recursive',
      target: '/var/www',
      targets: ['/var/www'],
      scope: 'directory',
      confirmationKind: 'target',
      confirmationText: 'www'
    });
  });

  it('есть объект класса disk — жребий только среди disk, никогда среди прочих', () => {
    mockAnalyzeDangers.mockReturnValue([hit('./cache'), hit('/', 'disk')]);
    for (let i = 0; i < 40; i++) {
      const prompt = blockedPrompt('rm -rf ./cache && rm -rf /');
      expect(prompt.target).toBe('/');
      expect(prompt.scope).toBe('disk');
      expect(prompt.targets).toEqual(['./cache', '/']);
    }
  });

  it('несколько disk — жребий среди них, остальные ступени не участвуют', () => {
    mockAnalyzeDangers.mockReturnValue([hit('dist'), hit('/dev/sda', 'disk'), hit('/dev/sdb', 'disk')]);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) seen.add(blockedPrompt('cmd').target);
    expect(seen).toEqual(new Set(['/dev/sda', '/dev/sdb']));
  });

  it('равные по тяжести объекты — за 60 прогонов встречаются оба (выбор не выучить)', () => {
    mockAnalyzeDangers.mockReturnValue([hit('dist'), hit('node_modules')]);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) seen.add(blockedPrompt('rm -rf dist && rm -rf node_modules').target);
    expect(seen).toEqual(new Set(['dist', 'node_modules']));
  });

  it('directory и file равны между собой — обе ступени в пуле', () => {
    mockAnalyzeDangers.mockReturnValue([hit('dist'), hit('app.log', 'file')]);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) seen.add(blockedPrompt('rm -rf dist && truncate -s 0 app.log').target);
    expect(seen).toEqual(new Set(['dist', 'app.log']));
  });

  it('жребий бросается один раз: подтверждается ровно показанный объект, не соседний', () => {
    mockAnalyzeDangers.mockReturnValue([hit('dist'), hit('node_modules')]);
    for (let i = 0; i < 30; i++) {
      const prompt = blockedPrompt('rm -rf dist && rm -rf node_modules');
      const other = prompt.confirmationText === 'dist' ? 'node_modules' : 'dist';
      expect(confirmDangerousCommand(prompt.requestId, other)).toBe(false);

      const again = blockedPrompt('rm -rf dist && rm -rf node_modules');
      expect(confirmDangerousCommand(again.requestId, again.confirmationText)).toBe(true);
    }
  });

  it('одна цель разными паттернами — в списке один раз, в жребии по самому тяжёлому', () => {
    // rm -rf /dev/sdb1 && mkfs /dev/sdb1 && rm -rf ./cache: у /dev/sdb1 два
    // совпадения, тяжёлое (disk) второе. Оно и решает — просить ./cache нельзя.
    mockAnalyzeDangers.mockReturnValue([
      hit('/dev/sdb1'),
      { ...hit('/dev/sdb1', 'disk'), patternId: 'mkfs' },
      hit('./cache')
    ]);
    for (let i = 0; i < 40; i++) {
      const prompt = blockedPrompt('rm -rf /dev/sdb1 && mkfs /dev/sdb1 && rm -rf ./cache');
      expect(prompt.target).toBe('/dev/sdb1');
      expect(prompt.patternId).toBe('mkfs');
      expect(prompt.targets).toEqual(['/dev/sdb1', './cache']);
    }
  });

  it('равные по тяжести дубликаты цели не перекашивают жребий', () => {
    mockAnalyzeDangers.mockReturnValue([
      hit('/a'),
      { ...hit('/a'), patternId: 'shred', scope: 'file' },
      hit('/b')
    ]);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) seen.add(blockedPrompt('cmd').target);
    expect(seen).toEqual(new Set(['/a', '/b']));
  });

  it('жребий не перебрасывается: тот же requestId подтверждается показанным текстом', () => {
    // Единственный способ убедиться, что выбор живёт в pending, а не считается
    // заново при подтверждении: сдвинуть Math.random между показом и вводом.
    // Пересчёт дал бы соседний объект, и правильный ввод перестал бы подходить.
    mockAnalyzeDangers.mockReturnValue([hit('dist'), hit('node_modules')]);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const prompt = blockedPrompt('rm -rf dist && rm -rf node_modules');
      expect(prompt.confirmationText).toBe('dist');
      random.mockReturnValue(0.99);
      expect(confirmDangerousCommand(prompt.requestId, prompt.confirmationText)).toBe(true);
    } finally {
      random.mockRestore();
    }
  });

  it('patternId промпта — паттерн выбранного объекта', () => {
    mockAnalyzeDangers.mockReturnValue([
      { ...hit('dist'), patternId: 'rm-recursive' },
      { ...hit('/dev/sda', 'disk'), patternId: 'mkfs' }
    ]);
    const prompt = blockedPrompt('rm -rf dist && mkfs /dev/sdb1');
    expect(prompt.patternId).toBe('mkfs');
  });

  it('фрагмент без цели в жребии не участвует, но в списке объектов есть', () => {
    mockAnalyzeDangers.mockReturnValue([wordHit('fork-bomb', ':(){ :|:& };: ; rm -rf /var'), hit('/var')]);
    for (let i = 0; i < 30; i++) {
      const prompt = blockedPrompt(':(){ :|:& };: ; rm -rf /var');
      expect(prompt.confirmationKind).toBe('target');
      expect(prompt.target).toBe('/var');
      expect(prompt.targets).toEqual([':(){ :|:& };: ; rm -rf /var', '/var']);
    }
  });

  it('ни у одного фрагмента нет цели — подтверждение словом, как сегодня', () => {
    mockT.mockReturnValue('ПОДТВЕРЖДАЮ');
    mockAnalyzeDangers.mockReturnValue([
      wordHit('fork-bomb', ':(){ :|:& };: ; kill -9 1'),
      wordHit('kill-init', 'kill -9 1')
    ]);
    const prompt = blockedPrompt(':(){ :|:& };: ; kill -9 1');
    expect(prompt.confirmationKind).toBe('word');
    expect(prompt.confirmationText).toBe('ПОДТВЕРЖДАЮ');
    expect(prompt.targets).toEqual([':(){ :|:& };: ; kill -9 1', 'kill -9 1']);
  });

  it('сырой путь получает тот же список объектов', () => {
    mockAnalyzeDangers.mockReturnValue([hit('/var/www'), hit('/etc')]);
    const res = submitRawInput('s1', 'rm -rf /var/www && rm -rf /etc');
    if (res.status !== 'blocked') throw new Error('expected blocked');
    expect(res.prompt.targets).toEqual(['/var/www', '/etc']);
  });
});

/**
 * Обязательное покрытие (CLAUDE.md §4/§10): сырой путь sessionSendInput —
 * вставка/клик мимо промпта — не должен обходить Стража
 * (.scratch/raw-input-guard-check/spec.md).
 */
describe('submitRawInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(fakeConfig(true));
    mockGetSession.mockReturnValue(fakeSession(1));
    mockGetHost.mockReturnValue(fakeHost(true));
    mockAnalyzeDangers.mockReturnValue([]);
    mockAnalyzeAccessRisk.mockReturnValue(null);
  });

  it('короткий кусок (1-2 байта) — проверка не запускается, данные проходят как раньше', () => {
    const res = submitRawInput('s1', 'a');
    expect(res).toEqual({ status: 'sent' });
    expect(mockSendInput).toHaveBeenCalledWith('s1', 'a');
    expect(mockAnalyzeDangers).not.toHaveBeenCalled();
  });

  it('длинный безопасный текст — проходит без блокировки через sendInput', () => {
    const res = submitRawInput('s1', 'ls -la /var/www');
    expect(res).toEqual({ status: 'sent' });
    expect(mockSendInput).toHaveBeenCalledWith('s1', 'ls -la /var/www');
    expect(mockSendCommandLine).not.toHaveBeenCalled();
  });

  it('длинный опасный текст — блокируется, ничего не отправляется на сессию', () => {
    mockAnalyzeDangers.mockReturnValue([{
      patternId: 'rm-recursive',
      target: '/var/www',
      scope: 'directory',
      confirmationKind: 'target',
      confirmationText: 'www'
    }]);
    const res = submitRawInput('s1', 'rm -rf /var/www');
    expect(res).toMatchObject({
      status: 'blocked',
      prompt: { confirmationKind: 'target', confirmationText: 'www', target: '/var/www' }
    });
    expect(mockSendInput).not.toHaveBeenCalled();
    expect(mockSendCommandLine).not.toHaveBeenCalled();
  });

  it('неизвестная сессия — данные не отправляются', () => {
    mockGetSession.mockReturnValue(undefined);
    const res = submitRawInput('s1', 'rm -rf /var/www');
    expect(res).toEqual({ status: 'sent' });
    expect(mockSendInput).not.toHaveBeenCalled();
  });

  it('Страж выключен для хоста — опасный сырой текст всё равно уходит через sendInput', () => {
    mockGetHost.mockReturnValue(fakeHost(false));
    mockAnalyzeDangers.mockReturnValue([{
      patternId: 'rm-recursive',
      target: '/var/www',
      scope: 'directory',
      confirmationKind: 'target',
      confirmationText: 'www'
    }]);
    const res = submitRawInput('s1', 'rm -rf /var/www');
    expect(res.status).toBe('sent');
    expect(mockSendInput).toHaveBeenCalledWith('s1', 'rm -rf /var/www');
  });
});

describe('confirmDangerousCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(fakeConfig(true));
    mockGetSession.mockReturnValue(fakeSession(1));
    mockGetHost.mockReturnValue(fakeHost(true));
  });

  function block(): string {
    mockAnalyzeDangers.mockReturnValue([{
      patternId: 'rm-recursive',
      target: '/var/www',
      scope: 'directory',
      confirmationKind: 'target',
      confirmationText: 'www'
    }]);
    const res = submitCommand('s1', 'rm -rf /var/www');
    if (res.status !== 'blocked') throw new Error('expected blocked');
    return res.prompt.requestId;
  }

  it('точное совпадение — отправляет команду со статусом confirmed', () => {
    const id = block();
    const ok = confirmDangerousCommand(id, 'www');
    expect(ok).toBe(true);
    expect(mockSendCommandLine).toHaveBeenLastCalledWith('s1', 'rm -rf /var/www', 'confirmed');
  });

  it('неверный текст — не отправляет и возвращает false', () => {
    const id = block();
    const ok = confirmDangerousCommand(id, 'wrong');
    expect(ok).toBe(false);
    expect(mockSendCommandLine).not.toHaveBeenCalled();
  });

  it('повторный вызов с тем же requestId — уже удалён из pending, всегда false', () => {
    const id = block();
    confirmDangerousCommand(id, 'wrong');
    const second = confirmDangerousCommand(id, 'www');
    expect(second).toBe(false);
  });

  it('неизвестный requestId — false, без побочных эффектов', () => {
    const ok = confirmDangerousCommand('unknown-id', 'www');
    expect(ok).toBe(false);
    expect(mockSendCommandLine).not.toHaveBeenCalled();
  });

  function blockRaw(): string {
    mockAnalyzeDangers.mockReturnValue([{
      patternId: 'rm-recursive',
      target: '/var/www',
      scope: 'directory',
      confirmationKind: 'target',
      confirmationText: 'www'
    }]);
    const res = submitRawInput('s1', 'rm -rf /var/www');
    if (res.status !== 'blocked') throw new Error('expected blocked');
    return res.prompt.requestId;
  }

  it('подтверждение заблокированного сырого текста — отправляет через sendInput, без sendCommandLine', () => {
    const id = blockRaw();
    const ok = confirmDangerousCommand(id, 'www');
    expect(ok).toBe(true);
    expect(mockSendInput).toHaveBeenCalledWith('s1', 'rm -rf /var/www');
    expect(mockSendCommandLine).not.toHaveBeenCalled();
  });
});

describe('cancelDangerousCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(fakeConfig(true));
    mockGetSession.mockReturnValue(fakeSession(1));
    mockGetHost.mockReturnValue(fakeHost(true));
  });

  it('известный requestId — записывает в историю как заблокированную (HIST-05)', () => {
    mockAnalyzeDangers.mockReturnValue([{
      patternId: 'rm-recursive',
      target: '/var/www',
      scope: 'directory',
      confirmationKind: 'target',
      confirmationText: 'www'
    }]);
    const res = submitCommand('s1', 'rm -rf /var/www');
    if (res.status !== 'blocked') throw new Error('expected blocked');
    cancelDangerousCommand(res.prompt.requestId);
    expect(mockRecordBlockedCommand).toHaveBeenCalledWith('s1', 'rm -rf /var/www');
    // Повторная отмена — pending уже пуст, без падения и без повторной записи
    mockRecordBlockedCommand.mockClear();
    cancelDangerousCommand(res.prompt.requestId);
    expect(mockRecordBlockedCommand).not.toHaveBeenCalled();
  });

  it('неизвестный requestId — не падает, ничего не пишет', () => {
    expect(() => cancelDangerousCommand('unknown-id')).not.toThrow();
    expect(mockRecordBlockedCommand).not.toHaveBeenCalled();
  });

  it('отмена заблокированного сырого текста (submitRawInput) — тоже записывает в историю', () => {
    mockAnalyzeDangers.mockReturnValue([{
      patternId: 'rm-recursive',
      target: '/var/www',
      scope: 'directory',
      confirmationKind: 'target',
      confirmationText: 'www'
    }]);
    const res = submitRawInput('s1', 'rm -rf /var/www');
    if (res.status !== 'blocked') throw new Error('expected blocked');
    cancelDangerousCommand(res.prompt.requestId);
    expect(mockRecordBlockedCommand).toHaveBeenCalledWith('s1', 'rm -rf /var/www');
  });
});

/**
 * GUARD-07: предупреждение о риске потери SSH-доступа — проверяется после
 * деструктивных паттернов, подтверждается кнопкой (без type-to-confirm),
 * подчиняется тем же переключателям GUARD-05.
 */
describe('GUARD-07 — риск потери SSH-доступа', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(fakeConfig(true));
    mockGetSession.mockReturnValue(fakeSession(1));
    mockGetHost.mockReturnValue(fakeHost(true));
    mockAnalyzeDangers.mockReturnValue([]);
    mockAnalyzeAccessRisk.mockReturnValue({ riskId: 'sshd-service' });
  });

  it('рискованная команда — status access-risk с riskId, на сервер не уходит', () => {
    const res = submitCommand('s1', 'systemctl restart sshd');
    expect(res).toMatchObject({
      status: 'access-risk',
      prompt: { sessionId: 's1', command: 'systemctl restart sshd', riskId: 'sshd-service' }
    });
    expect(mockSendCommandLine).not.toHaveBeenCalled();
  });

  it('команда совпала с деструктивным паттерном — обычная модалка, риск не проверяется', () => {
    mockAnalyzeDangers.mockReturnValue([{
      patternId: 'rm-recursive',
      target: '~/.ssh',
      scope: 'directory',
      confirmationKind: 'target',
      confirmationText: '.ssh'
    }]);
    const res = submitCommand('s1', 'rm -rf ~/.ssh');
    expect(res.status).toBe('blocked');
    expect(mockAnalyzeAccessRisk).not.toHaveBeenCalled();
  });

  it('Страж выключен глобально — предупреждение о риске тоже не показывается (GUARD-05)', () => {
    mockLoadConfig.mockReturnValue(fakeConfig(false));
    const res = submitCommand('s1', 'systemctl restart sshd');
    expect(res).toEqual({ status: 'sent' });
    expect(mockAnalyzeAccessRisk).not.toHaveBeenCalled();
    expect(mockSendCommandLine).toHaveBeenCalled();
  });

  it('Страж выключен для хоста — предупреждение о риске не показывается', () => {
    mockGetHost.mockReturnValue(fakeHost(false));
    const res = submitCommand('s1', 'systemctl restart sshd');
    expect(res.status).toBe('sent');
  });

  it('подтверждение кнопкой (пустой текст) — команда уходит со статусом confirmed', () => {
    const res = submitCommand('s1', 'systemctl restart sshd');
    if (res.status !== 'access-risk') throw new Error('expected access-risk');
    const ok = confirmDangerousCommand(res.prompt.requestId, '');
    expect(ok).toBe(true);
    expect(mockSendCommandLine).toHaveBeenCalledWith('s1', 'systemctl restart sshd', 'confirmed');
  });

  it('отмена — в историю как заблокированная (HIST-05)', () => {
    const res = submitCommand('s1', 'systemctl restart sshd');
    if (res.status !== 'access-risk') throw new Error('expected access-risk');
    cancelDangerousCommand(res.prompt.requestId);
    expect(mockRecordBlockedCommand).toHaveBeenCalledWith('s1', 'systemctl restart sshd');
    expect(mockSendCommandLine).not.toHaveBeenCalled();
  });

  it('сырой путь (submitRawInput) — тот же access-risk, подтверждение шлёт через sendInput', () => {
    const res = submitRawInput('s1', 'systemctl restart sshd');
    if (res.status !== 'access-risk') throw new Error('expected access-risk');
    const ok = confirmDangerousCommand(res.prompt.requestId, '');
    expect(ok).toBe(true);
    expect(mockSendInput).toHaveBeenCalledWith('s1', 'systemctl restart sshd');
    expect(mockSendCommandLine).not.toHaveBeenCalled();
  });
});

/**
 * Сквозные тесты Стража: patterns × manager (.scratch/guard-crossing-tests/spec.md).
 * Единственный блок во всём файле, где vi.mock('./patterns') наполняется настоящей
 * реализацией через vi.importActual — остальные моки (sessionManager/hosts/config/i18n)
 * остаются на месте. Проверяет три инварианта, которые раньше держались только на
 * моках или комментарии; существующие 26 кейсов выше не меняются и должны остаться
 * зелёными — их зелёность подтверждает, что importActual не протёк за пределы блока.
 */
describe('Страж целиком — patterns × manager (сквозные тесты)', () => {
  // По одному представительному, ПРОСТОМУ (не составному — см. Out of Scope спеки)
  // образцу на каждый DangerPatternId. Record — так что новый id без образца
  // не компилируется (это и есть проверка «порог × пересечение» из инварианта 1).
  // Образцы и их target — из существующего корпуса guard/patterns.test.ts, не
  // придуманы заново.
  const CORPUS: Record<DangerPatternId, { sample: string; target: string }> = {
    'rm-recursive': { sample: 'rm -rf /var/www', target: '/var/www' },
    'dd-write': { sample: 'dd if=/dev/zero of=/dev/sda bs=1M', target: '/dev/sda' },
    mkfs: { sample: 'mkfs /dev/sdb1', target: '/dev/sdb1' },
    'chmod-777': { sample: 'chmod -R 777 /var/www', target: '/var/www' },
    truncate: { sample: 'truncate -s 0 /var/log/syslog', target: '/var/log/syslog' },
    'redirect-device': { sample: 'echo test > /dev/sda', target: '/dev/sda' },
    shred: { sample: 'shred -n 3 /dev/sdb', target: '/dev/sdb' },
    wipefs: { sample: 'wipefs -a /dev/sdc', target: '/dev/sdc' },
    'fork-bomb': { sample: ':(){ :|:& };:', target: ':(){ :|:& };:' },
    'drop-database': { sample: 'mysql -e "DROP DATABASE production"', target: 'production' },
    'kill-init': { sample: 'kill -9 1', target: 'kill -9 1' }
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(fakeConfig(true));
    mockGetSession.mockReturnValue(fakeSession(1));
    mockGetHost.mockReturnValue(fakeHost(true));
    // clearAllMocks не сбрасывает implementation, выставленную в другом describe —
    // фиксируем поведение мока i18n явно, чтобы блок не зависел от порядка тестов.
    mockT.mockImplementation((key: string) => key);
    const actual = await vi.importActual<typeof import('./patterns')>('./patterns');
    mockAnalyzeDangers.mockImplementation(actual.analyzeDangers);
    mockAnalyzeAccessRisk.mockImplementation(actual.analyzeAccessRisk);
  });

  describe('инвариант 1 — ни один паттерн корпуса не проваливается на настоящих regex через сырой путь', () => {
    for (const [patternId, { sample, target }] of Object.entries(CORPUS) as [
      DangerPatternId,
      { sample: string; target: string }
    ][]) {
      it(`${patternId}: "${sample}" — blocked, sendInput не вызывается`, () => {
        const res = submitRawInput('s1', sample);
        expect(res.status).toBe('blocked');
        if (res.status !== 'blocked') return;
        expect(res.prompt.patternId).toBe(patternId);
        // GUARD-03: реальная цель, не заглушка мока — регресс семантики цели.
        expect(res.prompt.target).toBe(target);
        expect(res.prompt.confirmationText.length).toBeGreaterThan(0);
        expect(mockSendInput).not.toHaveBeenCalled();
      });
    }
  });

  it('инвариант 2 — опасность (analyzeDangers) проверяется раньше риска доступа (GUARD-07)', () => {
    // Составная команда: обе половины разбираются обеими функциями настоящей
    // реализации (splitCompound). Цель берётся из опасного фрагмента, а не с
    // конца всей строки — иначе подтверждать пришлось бы «sshd».
    const res = submitCommand('s1', 'rm -rf /tmp/build && systemctl stop sshd');
    expect(res.status).toBe('blocked');
    if (res.status !== 'blocked') return;
    expect(res.prompt.patternId).toBe('rm-recursive');
    expect(res.prompt.target).toBe('/tmp/build');
  });

  it('инвариант 3 — круг подтверждения на настоящих данных: Команда (sendCommandLine)', () => {
    const { sample } = CORPUS['rm-recursive'];

    const blocked = submitCommand('s1', sample);
    if (blocked.status !== 'blocked') throw new Error('expected blocked');
    expect(confirmDangerousCommand(blocked.prompt.requestId, 'заведомо неверный текст')).toBe(
      false
    );
    expect(mockSendCommandLine).not.toHaveBeenCalled();

    const blocked2 = submitCommand('s1', sample);
    if (blocked2.status !== 'blocked') throw new Error('expected blocked');
    expect(confirmDangerousCommand(blocked2.prompt.requestId, blocked2.prompt.confirmationText)).toBe(
      true
    );
    expect(mockSendCommandLine).toHaveBeenCalledWith('s1', sample, 'confirmed');
  });

  it('инвариант 3 — круг подтверждения на настоящих данных: Сырой текст (sendInput, без \\n)', () => {
    const { sample } = CORPUS['rm-recursive'];

    const blocked = submitRawInput('s1', sample);
    if (blocked.status !== 'blocked') throw new Error('expected blocked');
    expect(confirmDangerousCommand(blocked.prompt.requestId, 'заведомо неверный текст')).toBe(
      false
    );
    expect(mockSendInput).not.toHaveBeenCalled();

    const blocked2 = submitRawInput('s1', sample);
    if (blocked2.status !== 'blocked') throw new Error('expected blocked');
    expect(confirmDangerousCommand(blocked2.prompt.requestId, blocked2.prompt.confirmationText)).toBe(
      true
    );
    expect(mockSendInput).toHaveBeenCalledWith('s1', sample);
    expect(mockSendCommandLine).not.toHaveBeenCalled();
  });
});
