import { randomUUID } from 'node:crypto';
import type { AccessRiskPrompt, DangerousCommandPrompt, SubmitResult } from '@shared/guard';
import { getHost } from '../hosts/repository';
import { loadConfig } from '../config/store';
import {
  getSession,
  recordBlockedCommand,
  sendCommandLine,
  sendInput
} from '../ssh/sessionManager';
import type { DangerMatch } from './patterns';
import { analyzeAccessRisk, analyzeDangers } from './patterns';
import { t } from '../i18n';

/**
 * Перехват команд Стражем в main process ДО отправки по SSH (GUARD-02).
 * Проверяются команды из всех источников: композер, каталог, история, сниппеты
 * (GUARD-04) — все они приходят через submitCommand. Сырой IPC-канал
 * (sessionSendInput — вставка/клик мимо промпта, .scratch/raw-input-guard-check/spec.md)
 * проверяется через submitRawInput, единственный сырой путь отправки на сервер.
 * Логирование в историю (blocked/confirmed, GUARD-06) добавится на Этапе 7.
 */

/** Живое нажатие клавиши — 1 символ либо короткая escape-последовательность
 *  (стрелка и т.п., ~3 байта); собранный текст команды заметно длиннее. Ниже
 *  порога — не проверяем вовсе, это неотличимо от посимвольного ввода. */
const RAW_CHECK_THRESHOLD = 5;

interface Pending {
  sessionId: string;
  command: string;
  confirmationText: string;
  /** Как отправлять при подтверждении: 'command' — sendCommandLine (промпт,
   *  как раньше), 'raw' — sendInput (сырой текст, без перевода строки/эха). */
  mode: 'command' | 'raw';
  /** 'danger' — type-to-confirm (GUARD-02); 'accessRisk' — предупреждение о
   *  риске потери SSH-доступа, подтверждается кнопкой без текста (GUARD-07). */
  kind: 'danger' | 'accessRisk';
}

const pending = new Map<string, Pending>();

/** Активен ли Страж для сессии: глобально И для конкретного хоста (GUARD-05). */
function guardEnabledFor(sessionId: string): boolean {
  if (!loadConfig().guard.globalEnabled) return false;
  const session = getSession(sessionId);
  if (!session) return true;
  const host = getHost(session.hostId);
  return host ? host.guardEnabled : true;
}

/**
 * Отправка команды в сессию. Если Страж включён и команда распознана как
 * опасная — команда НЕ уходит на сервер, возвращается запрос подтверждения.
 * Иначе команда отправляется с переводом строки.
 */
export function submitCommand(sessionId: string, command: string): SubmitResult {
  const session = getSession(sessionId);
  if (!session) return { status: 'sent' }; // неизвестная сессия — IPC-слой уже отверг

  if (guardEnabledFor(sessionId)) {
    const danger = dangerPrompt(sessionId, command, 'command');
    if (danger) return { status: 'blocked', prompt: danger };
    const risk = riskPrompt(sessionId, command, 'command');
    if (risk) return { status: 'access-risk', prompt: risk };
  }

  sendCommandLine(sessionId, command);
  return { status: 'sent' };
}

/**
 * Ступень тяжести объекта. Ступеней ровно две: `disk` выше всех, остальные
 * вровень. Тяжесть различается только там, где различие бесспорно (`rm -rf /`
 * против `./cache`); где спорно — решает жребий. Более дробная лестница
 * схлопнула бы пул и вернула привычку набирать один и тот же объект не читая
 * (.scratch/guard-multi-fragment-confirm/spec.md, решение 1).
 */
function severity(match: DangerMatch): number {
  return match.scope === 'disk' ? 1 : 0;
}

/**
 * Какой из опасных фрагментов просить набрать. Жребий среди самых тяжёлых целей:
 * детерминированное правило пользователь выучивает наизусть и перестаёт читать
 * модалку, случайный выбор выучить нельзя. Фрагменты без цели (форк-бомба,
 * kill -9 1) в жребии не участвуют — им нечего называть. Бросается ОДИН раз,
 * при построении промпта: повторный ввод после опечатки просит тот же объект.
 */
function drawTarget(dangers: DangerMatch[]): DangerMatch {
  const withTarget = dangers.filter((d) => d.confirmationKind === 'target');
  if (withTarget.length === 0) return dangers[0]!; // все без цели — подтверждение словом

  // Один объект — один участник жребия, иначе повтор цели перекашивал бы шансы.
  // Из совпадений по одной цели остаётся самое тяжёлое: у `/dev/sdb1` из
  // `rm -rf /dev/sdb1 && mkfs /dev/sdb1` это mkfs (disk), и потерять его нельзя —
  // иначе объект перестанет быть самым тяжёлым и просить могут соседний.
  const heaviestPerTarget = new Map<string, DangerMatch>();
  for (const d of withTarget) {
    const kept = heaviestPerTarget.get(d.target);
    if (!kept || severity(d) > severity(kept)) heaviestPerTarget.set(d.target, d);
  }
  const candidates = [...heaviestPerTarget.values()];
  const top = Math.max(...candidates.map(severity));
  const pool = candidates.filter((d) => severity(d) === top);
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/**
 * Промпт type-to-confirm (GUARD-02) со списком ВСЕХ опасных объектов строки и
 * одним — выбранным жребием — объектом для набора. Возвращает null, если
 * опасного не найдено. Побочный эффект: регистрирует запись в pending.
 */
function dangerPrompt(
  sessionId: string,
  command: string,
  mode: 'command' | 'raw'
): DangerousCommandPrompt | null {
  const dangers = analyzeDangers(command);
  if (dangers.length === 0) return null;
  const chosen = drawTarget(dangers);
  const requestId = randomUUID();
  // Слово подтверждения (в отличие от имени объекта) — UI-текст, локализуется
  // здесь через i18n main-процесса; patterns.ts намеренно его не решает (§5a).
  const confirmationText =
    chosen.confirmationKind === 'word' ? t('guard.confirmWord') : chosen.confirmationText;
  pending.set(requestId, { sessionId, command, confirmationText, mode, kind: 'danger' });
  return {
    requestId,
    sessionId,
    command,
    patternId: chosen.patternId,
    target: chosen.target,
    targets: [...new Set(dangers.map((d) => d.target))],
    scope: chosen.scope,
    confirmationKind: chosen.confirmationKind,
    confirmationText
  };
}

/**
 * GUARD-07: риск потери SSH-доступа. Проверяется только когда analyzeDangers
 * ничего не нашёл (вызывающие следят за порядком) — команда, совпавшая с
 * деструктивным паттерном, получает обычную type-to-confirm модалку, двойного
 * предупреждения нет. Подтверждение — кнопкой, без текста (см. confirmDangerousCommand).
 */
function riskPrompt(
  sessionId: string,
  command: string,
  mode: 'command' | 'raw'
): AccessRiskPrompt | null {
  const risk = analyzeAccessRisk(command);
  if (!risk) return null;
  const requestId = randomUUID();
  pending.set(requestId, { sessionId, command, confirmationText: '', mode, kind: 'accessRisk' });
  return { requestId, sessionId, command, riskId: risk.riskId };
}

/**
 * Проверка Стражем «сырого» пути ввода (sessionSendInput) — вставка/клик по
 * каталогу/истории/сниппету/breadcrumb, доставленные одним IPC-вызовом, в
 * момент, когда сессия не на промпте (см. .scratch/raw-input-guard-check/spec.md).
 * Живой посимвольный ввод (короче RAW_CHECK_THRESHOLD) не проверяется —
 * объективно неотличим от одного нажатия клавиши. В отличие от submitCommand,
 * непроверенный текст уходит через sendInput (без перевода строки/эхо-логики,
 * которая рассчитана на команду, набранную на промпте, а не на произвольный
 * текст, летящий в интерактивную программу).
 */
export function submitRawInput(sessionId: string, data: string): SubmitResult {
  const session = getSession(sessionId);
  if (!session) return { status: 'sent' }; // неизвестная сессия — sendInput сам no-op

  if (data.length >= RAW_CHECK_THRESHOLD && guardEnabledFor(sessionId)) {
    const danger = dangerPrompt(sessionId, data, 'raw');
    if (danger) return { status: 'blocked', prompt: danger };
    const risk = riskPrompt(sessionId, data, 'raw');
    if (risk) return { status: 'access-risk', prompt: risk };
  }

  sendInput(sessionId, data);
  return { status: 'sent' };
}

/**
 * Подтверждение опасной команды: отправляется только при точном совпадении
 * введённого текста с именем объекта/словом подтверждения (GUARD-02).
 * Предупреждение о риске доступа (GUARD-07) подтверждается кнопкой —
 * текст не сверяется (renderer шлёт пустую строку).
 * Возвращает allowed — выполнилась ли отправка.
 */
export function confirmDangerousCommand(requestId: string, confirmationText: string): boolean {
  const p = pending.get(requestId);
  if (!p) return false;
  pending.delete(requestId);
  if (p.kind !== 'accessRisk' && confirmationText !== p.confirmationText) return false;
  if (p.mode === 'raw') {
    // Сырой текст — точно как был вставлен, без перевода строки/эхо-логики.
    sendInput(p.sessionId, p.command);
  } else {
    // Подтверждённая опасная команда попадёт в историю со статусом confirmed (HIST-05)
    sendCommandLine(p.sessionId, p.command, 'confirmed');
  }
  return true;
}

/** Отмена опасной команды пользователем — в историю как «заблокировано» (HIST-05). */
export function cancelDangerousCommand(requestId: string): void {
  const p = pending.get(requestId);
  pending.delete(requestId);
  if (p) recordBlockedCommand(p.sessionId, p.command);
}
