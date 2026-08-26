import type { JSX } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthMethod, Host, HostInput } from '@shared/hosts';
import type { TestConnectionResult } from '@shared/ssh';
import { useHosts } from '@/stores/hosts';
import { useSessions } from '@/stores/sessions';
import { useConfig } from '@/stores/config';
import { Icon } from '@/components/common/Icon';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ToggleRow } from '@/components/Settings/controls';
import { SshKeyWizard } from './SshKeyWizard';
import { useBackdropClose } from '@/hooks/useBackdropClose';
import { useEscapeClose } from '@/hooks/useEscapeClose';
import { wrapJumpStep } from '@/components/Terminal/connectionLogText';

/**
 * Drawer «Новое подключение» (скриншот 03-Newconn, Design_Brief §3.5):
 * выезжает справа (esh-slidein), поля с подсказками для новичков (§5.3 ТЗ).
 * Секрет уходит отдельным аргументом IPC сразу в keychain; при редактировании
 * реальное значение НИКОГДА не подставляется — только состояние «сохранён» (§10 гайда).
 */

interface FormState {
  name: string;
  address: string;
  port: string;
  username: string;
  authMethod: AuthMethod;
  keyPath: string;
  groupId: string; // '' = без группы
  proxyJumpHostId: number | undefined; // SSH-05 тикет 04: выбирается в форме
  secret: string; // пароль или passphrase; не хранится дольше сабмита
  guardEnabled: boolean; // GUARD-05
  historyEnabled: boolean; // HIST-07
}

/**
 * Search-комбобокс выбора jump-хоста (SSH-05, тикет 04): переиспользует
 * паттерн текстового поиска по хостам (HM-05, `HostPanel.tsx`), а не заводит
 * отдельный библиотечный компонент. Кандидаты — хосты без своего
 * proxyJumpHostId (single-hop, ADR 0006), минус сам редактируемый хост.
 *
 * Инвариант single-hop двусторонний, поэтому одного фильтра кандидатов мало:
 * если сам редактируемый хост уже служит чьим-то jump-хостом, поле целиком
 * запирается — иначе через него собиралась бы цепочка A→B→C с другого конца.
 * Окончательное решение всё равно за main (`repo.checkJumpHost`): здесь оно
 * лишь объясняется пользователю до отправки формы.
 */
function JumpHostField({
  hosts,
  excludeHostId,
  value,
  onChange
}: {
  hosts: Host[];
  excludeHostId: number | undefined;
  value: number | undefined;
  onChange: (id: number | undefined) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const selected = hosts.find((h) => h.id === value);
  const usedAsJumpBy = hosts.filter((h) => h.proxyJumpHostId === excludeHostId);
  const locked = excludeHostId !== undefined && usedAsJumpBy.length > 0;
  const candidates = hosts.filter(
    (h) => h.proxyJumpHostId === undefined && h.id !== excludeHostId
  );
  const q = query.trim().toLowerCase();
  const filtered = q === '' ? candidates : candidates.filter((h) => h.name.toLowerCase().includes(q));

  const inputCls =
    'h-[34px] w-full rounded-[4px] border border-border-default bg-bg-base px-[11px] text-[13px] text-text-strong outline-none placeholder:text-text-dim focus:border-accent';

  if (locked) {
    return (
      <div>
        <label className="mb-1 block text-[12.5px] font-medium text-text-strong" htmlFor="conn-jumphost">
          {t('conn.jumpHost')}
        </label>
        <input
          id="conn-jumphost"
          className={`${inputCls} cursor-not-allowed opacity-60`}
          value={t('conn.jumpHostNone')}
          readOnly
          disabled
        />
        <div className="mt-1 text-[12px] text-text-dim">
          {t('conn.jumpHostLocked', { hosts: usedAsJumpBy.map((h) => h.name).join(', ') })}
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <label className="mb-1 block text-[12.5px] font-medium text-text-strong" htmlFor="conn-jumphost">
        {t('conn.jumpHost')}
      </label>
      <input
        id="conn-jumphost"
        className={inputCls}
        placeholder={t('conn.jumpHostSearchPlaceholder')}
        value={open ? query : (selected?.name ?? t('conn.jumpHostNone'))}
        readOnly={!open}
        onFocus={() => {
          setQuery('');
          setOpen(true);
        }}
        onChange={(e) => setQuery(e.target.value)}
      />
      {open && (
        <div className="absolute top-full right-0 left-0 z-10 mt-1 max-h-[180px] overflow-y-auto rounded-[4px] border border-border-default bg-bg-elevated shadow-lg">
          <button
            type="button"
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
            className="flex h-8 w-full items-center px-[11px] text-left text-[12.5px] text-text-muted hover:bg-bg-elevated-2"
          >
            {t('conn.jumpHostNone')}
          </button>
          {filtered.length === 0 ? (
            <div className="px-[11px] py-2 text-[12px] text-text-dim">{t('conn.jumpHostEmpty')}</div>
          ) : (
            filtered.map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => {
                  onChange(h.id);
                  setOpen(false);
                }}
                className="flex h-8 w-full items-center px-[11px] text-left text-[12.5px] text-text-strong hover:bg-bg-elevated-2"
              >
                {h.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function NewConnectionDrawer(): JSX.Element | null {
  const { t } = useTranslation();
  const { drawer, closeDrawer, hosts, groups, refresh } = useHosts();
  const { connect } = useSessions();
  const { config } = useConfig();
  // SET-05/GUIDE-06: подсказки под полями скрываются в «Режиме эксперта» —
  // enableExpert/enableAllUi в SettingsScreen переключают этот же флаг вместе
  // с ui.expertMode, отдельная проверка expertMode тут не нужна.
  const showHints = config?.ui.hints.connectionDialog ?? true;
  const [form, setForm] = useState<FormState | null>(null);
  const [hasSavedSecret, setHasSavedSecret] = useState(false);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [deleteSecretConfirmOpen, setDeleteSecretConfirmOpen] = useState(false);
  const [keyFileExists, setKeyFileExists] = useState(true);
  const [keyWizardOpen, setKeyWizardOpen] = useState(false);
  const [closing, setClosing] = useState(false);

  const editHost = drawer.editHost;

  // Держим форму смонтированной до конца анимации выезда обратно (esh-slideout)
  // — иначе drawer пропадает мгновенно и анимация скрытия не проигрывается.
  // Размонтирование по onAnimationEnd (ниже), не по таймеру: таймер, чуть
  // разошедшийся с реальной длительностью CSS-анимации, обрезал последний
  // кадр — рывок/«мелькание» в момент исчезновения.
  // useLayoutEffect, не useEffect: closing должен выставиться синхронно до
  // покраски кадра браузером — иначе один кадр рендерится с drawer.open=false
  // и closing ещё false (условие ниже возвращает null), оверлей на миг
  // полностью пропадает и тут же «внезапно» появляется заново — то самое мелькание.
  useLayoutEffect(() => {
    if (!drawer.open) {
      if (!form) return;
      setClosing(true);
      return;
    }
    setClosing(false);
    setError(false);
    setHasSavedSecret(false);
    setTestResult(null);
    setKeyFileExists(true);
    setKeyWizardOpen(false);
    if (editHost) {
      setForm({
        name: editHost.name,
        address: editHost.address,
        port: String(editHost.port),
        username: editHost.username,
        authMethod: editHost.authMethod,
        keyPath: editHost.keyPath ?? '',
        groupId: editHost.groupId !== undefined ? String(editHost.groupId) : '',
        proxyJumpHostId: editHost.proxyJumpHostId,
        secret: '',
        guardEnabled: editHost.guardEnabled,
        historyEnabled: editHost.historyEnabled
      });
      void window.lucidSSH.hostHasSecret(editHost.id).then(setHasSavedSecret);
    } else {
      const preset = drawer.presetQuickConnect;
      setForm({
        name: preset ? `${preset.username}@${preset.address}` : '',
        address: preset?.address ?? '',
        port: preset ? String(preset.port) : '22',
        username: preset?.username ?? '',
        authMethod: 'password',
        keyPath: '',
        groupId: drawer.presetGroupId !== undefined ? String(drawer.presetGroupId) : '',
        proxyJumpHostId: undefined,
        secret: '',
        guardEnabled: true,
        historyEnabled: true
      });
    }
  }, [drawer.open, editHost, drawer.presetGroupId, drawer.presetQuickConnect]);

  useEffect(() => {
    if (!drawer.open || !form || form.authMethod !== 'key') return;
    let cancelled = false;
    void window.lucidSSH
      .keyFileExists(form.keyPath)
      .then((exists) => {
        if (!cancelled) setKeyFileExists(exists);
      })
      .catch(() => {
        if (!cancelled) setKeyFileExists(true);
      });
    return () => {
      cancelled = true;
    };
  }, [drawer.open, form?.authMethod, form?.keyPath]);

  useEscapeClose('new-connection-drawer', closeDrawer, drawer.open);

  // До early return ниже: хук должен звонить каждый рендер одинаково
  // (Rules of Hooks) — вызов после `if (...) return null` менял бы число
  // хуков между «закрыт»/«открыт» и валил бы всё приложение.
  const backdrop = useBackdropClose(closeDrawer);

  if ((!drawer.open && !closing) || !form) return null;

  const set = (patch: Partial<FormState>): void => setForm({ ...form, ...patch });

  const portNum = Number(form.port);
  const valid =
    form.name.trim().length > 0 &&
    form.address.trim().length > 0 &&
    form.username.trim().length > 0 &&
    Number.isInteger(portNum) &&
    portNum >= 1 &&
    portNum <= 65535 &&
    (form.authMethod === 'password' || form.keyPath.trim().length > 0);

  const buildInput = (): HostInput => ({
    name: form.name.trim(),
    address: form.address.trim(),
    port: portNum,
    username: form.username.trim(),
    authMethod: form.authMethod,
    keyPath: form.authMethod === 'key' ? form.keyPath.trim() : undefined,
    groupId: form.groupId !== '' ? Number(form.groupId) : undefined,
    guardEnabled: form.guardEnabled,
    historyEnabled: form.historyEnabled,
    proxyJumpHostId: form.proxyJumpHostId,
    note: editHost?.note
  });

  const secretOrUndef = (): string | undefined =>
    form.secret.length > 0 ? form.secret : undefined;

  const deleteSecret = async (): Promise<void> => {
    if (!editHost) return;
    await window.lucidSSH.hostDeleteSecret(editHost.id);
    setHasSavedSecret(false);
    setDeleteSecretConfirmOpen(false);
  };

  /** Сохранить хост; при connect=true — сразу подключиться (кнопка «Подключить»). */
  const save = async (doConnect: boolean): Promise<void> => {
    if (!valid || saving) return;
    setSaving(true);
    setError(false);
    const secret = secretOrUndef();
    try {
      let hostId: number;
      if (editHost) {
        await window.lucidSSH.updateHost(editHost.id, buildInput(), secret);
        hostId = editHost.id;
      } else {
        hostId = (await window.lucidSSH.createHost(buildInput(), secret)).id;
      }
      await refresh();
      closeDrawer();
      if (doConnect) await connect(hostId);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  /** Проверить соединение без сохранения (кнопка «Проверить соединение»). */
  const test = async (): Promise<void> => {
    if (!valid || testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await window.lucidSSH.testConnection(buildInput(), secretOrUndef(), editHost?.id);
      setTestResult(res);
    } catch {
      setTestResult({ ok: false, errorKey: 'clog.error.socket' });
    } finally {
      setTesting(false);
    }
  };

  const label = 'mb-1 block text-[12.5px] font-medium text-text-strong';
  const helper = 'mt-1 text-[11px] text-text-muted';
  const inputCls =
    'h-[34px] w-full rounded-[4px] border border-border-default bg-bg-base px-[11px] text-[13px] text-text-strong outline-none placeholder:text-text-dim focus:border-accent';

  return (
    <div
      className={`fixed inset-0 z-40 bg-black/70 ${
        closing ? 'animate-[esh-fadeout_.15s_ease_forwards]' : 'animate-[esh-fade_.15s_ease]'
      }`}
      {...backdrop}
      role="presentation"
    >
      <aside
        className={`absolute top-0 right-0 flex h-full w-[360px] flex-col border-l border-border-strong bg-bg-panel ${
          closing
            ? 'animate-[esh-slideout_.22s_cubic-bezier(.2,.7,.3,1)_forwards]'
            : 'animate-[esh-slidein_.22s_cubic-bezier(.2,.7,.3,1)]'
        }`}
        onAnimationEnd={(e) => {
          if (closing && e.animationName === 'esh-slideout') {
            setForm(null);
            setClosing(false);
          }
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={editHost ? t('conn.titleEdit') : t('conn.titleNew')}
      >
        <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-border-default px-[18px]">
          <span className="text-[15px] font-semibold text-text-strong">
            {editHost ? t('conn.titleEdit') : t('conn.titleNew')}
          </span>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={closeDrawer}
            className="flex size-[24px] items-center justify-center rounded-[4px] text-text-muted hover:bg-bg-elevated hover:text-text-strong"
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="flex-1 space-y-[15px] overflow-y-auto px-[18px] py-4">
          <div>
            <label className={label} htmlFor="conn-name">
              {t('conn.name')}
            </label>
            <input
              id="conn-name"
              className={inputCls}
              placeholder={t('conn.namePlaceholder')}
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              maxLength={100}
            />
            {showHints && <div className={helper}>{t('conn.nameHelper')}</div>}
          </div>

          <div>
            <label className={label} htmlFor="conn-address">
              {t('conn.address')}
            </label>
            <input
              id="conn-address"
              className={`${inputCls} font-mono`}
              placeholder={t('conn.addressPlaceholder')}
              value={form.address}
              onChange={(e) => set({ address: e.target.value })}
              maxLength={255}
            />
            {showHints && <div className={helper}>{t('conn.addressHelper')}</div>}
          </div>

          <div className="flex gap-3">
            <div className="w-[96px] shrink-0">
              <label className={label} htmlFor="conn-port">
                {t('conn.port')}
              </label>
              <input
                id="conn-port"
                className={`${inputCls} font-mono`}
                value={form.port}
                onChange={(e) => set({ port: e.target.value.replace(/[^0-9]/g, '') })}
                inputMode="numeric"
                maxLength={5}
              />
            </div>
            <div className="min-w-0 flex-1">
              <label className={label} htmlFor="conn-username">
                {t('conn.username')}
              </label>
              <input
                id="conn-username"
                className={`${inputCls} font-mono`}
                placeholder={t('conn.usernamePlaceholder')}
                value={form.username}
                onChange={(e) => set({ username: e.target.value })}
                maxLength={64}
              />
            </div>
          </div>
          {showHints && <div className={`${helper} -mt-2`}>{t('conn.usernameHelper')}</div>}

          <div>
            <span className={label}>{t('conn.auth')}</span>
            <div
              className="flex rounded-[4px] border border-border-default bg-bg-base p-[3px]"
              role="tablist"
            >
              {(['password', 'key'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={form.authMethod === m}
                  onClick={() => set({ authMethod: m })}
                  className={
                    form.authMethod === m
                      ? 'h-[28px] flex-1 rounded-[3px] bg-bg-elevated-2 text-[12.5px] font-medium text-text-strong'
                      : 'h-[28px] flex-1 rounded-[3px] text-[12.5px] text-text-dim hover:text-text-muted'
                  }
                >
                  {m === 'password' ? t('conn.authPassword') : t('conn.authKey')}
                </button>
              ))}
            </div>
          </div>

          {form.authMethod === 'password' ? (
            <div>
              <label className={label} htmlFor="conn-secret">
                {t('conn.password')}
              </label>
              <input
                id="conn-secret"
                type="password"
                className={inputCls}
                value={form.secret}
                onChange={(e) => set({ secret: e.target.value })}
                maxLength={1024}
                autoComplete="off"
              />
              {showHints && (
                <div className={helper}>
                  {hasSavedSecret ? t('conn.passwordSavedHelper') : t('conn.passwordHelper')}
                </div>
              )}
              {hasSavedSecret && (
                <button
                  type="button"
                  onClick={() => setDeleteSecretConfirmOpen(true)}
                  className="mt-1 text-[11px] text-danger-text hover:underline"
                >
                  {t('conn.deleteSecret')}
                </button>
              )}
            </div>
          ) : (
            <>
              <div>
                <label className={label} htmlFor="conn-keypath">
                  {t('conn.keyPath')}
                </label>
                <div className="flex gap-2">
                  <input
                    id="conn-keypath"
                    className={`${inputCls} min-w-0 flex-1 font-mono`}
                    value={form.keyPath}
                    onChange={(e) => set({ keyPath: e.target.value })}
                    maxLength={500}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void window.lucidSSH.pickKeyFile().then((p) => {
                        if (p) set({ keyPath: p });
                      });
                    }}
                    className="h-[34px] shrink-0 rounded-[4px] border border-[rgba(255,255,255,0.1)] bg-bg-elevated px-3 text-[12px] text-text-body hover:bg-bg-elevated-2"
                  >
                    {t('conn.browse')}
                  </button>
                </div>
                {showHints && <div className={helper}>{t('conn.keyPathHelper')}</div>}
                {!keyFileExists && (
                  <button
                    type="button"
                    onClick={() => setKeyWizardOpen(true)}
                    className="mt-2 h-[30px] w-full rounded-[4px] border border-[rgba(255,255,255,0.1)] bg-bg-elevated text-[12px] font-medium text-text-body hover:bg-bg-elevated-2"
                  >
                    {t('conn.generateKey')}
                  </button>
                )}
              </div>
              <div>
                <label className={label} htmlFor="conn-passphrase">
                  {t('conn.passphrase')}
                </label>
                <input
                  id="conn-passphrase"
                  type="password"
                  className={inputCls}
                  value={form.secret}
                  onChange={(e) => set({ secret: e.target.value })}
                  maxLength={1024}
                  autoComplete="off"
                />
                {showHints && (
                  <div className={helper}>
                    {hasSavedSecret ? t('conn.passwordSavedHelper') : t('conn.passphraseHelper')}
                  </div>
                )}
                {hasSavedSecret && (
                  <button
                    type="button"
                    onClick={() => setDeleteSecretConfirmOpen(true)}
                    className="mt-1 text-[11px] text-danger-text hover:underline"
                  >
                    {t('conn.deleteSecret')}
                  </button>
                )}
              </div>
            </>
          )}

          <div>
            <label className={label} htmlFor="conn-group">
              {t('conn.group')}
            </label>
            <select
              id="conn-group"
              className={`${inputCls} appearance-none`}
              value={form.groupId}
              onChange={(e) => set({ groupId: e.target.value })}
            >
              <option value="">{t('conn.groupNone')}</option>
              {groups.map((g) => (
                <option key={g.id} value={String(g.id)}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <JumpHostField
              hosts={hosts}
              excludeHostId={editHost?.id}
              value={form.proxyJumpHostId}
              onChange={(id) => set({ proxyJumpHostId: id })}
            />
            {showHints && <div className={helper}>{t('conn.jumpHostHelper')}</div>}
          </div>

          <ToggleRow
            title={t('conn.guardEnabled')}
            desc={t('conn.guardEnabledDesc')}
            on={form.guardEnabled}
            onChange={(v) => set({ guardEnabled: v })}
          />

          <ToggleRow
            title={t('conn.historyEnabled')}
            desc={t('conn.historyEnabledDesc')}
            on={form.historyEnabled}
            onChange={(v) => set({ historyEnabled: v })}
          />

          {error && (
            <div className="rounded-[6px] border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger-text">
              {t('conn.saveError')}
            </div>
          )}
        </div>

        <div className="shrink-0 space-y-[9px] border-t border-border-default px-[18px] py-[14px]">
          {testResult && (
            <div
              className={`rounded-[6px] px-3 py-2 text-[12px] ${
                testResult.ok
                  ? 'bg-success/10 text-success-bright'
                  : 'bg-danger/10 text-danger-text'
              }`}
            >
              {testResult.ok
                ? t('conn.testOk')
                : wrapJumpStep(t, testResult.step, t(testResult.errorKey ?? 'clog.error.socket'))}
            </div>
          )}
          <button
            type="button"
            disabled={!valid || testing || saving}
            onClick={() => void test()}
            className="h-9 w-full rounded-[4px] border border-[rgba(255,255,255,0.1)] bg-bg-elevated text-[13px] font-medium text-text-body hover:bg-bg-elevated-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {testing ? t('conn.testing') : t('conn.test')}
          </button>
          <button
            type="button"
            disabled={!valid || saving}
            onClick={() => void save(!editHost)}
            className="h-9 w-full rounded-[4px] bg-accent text-[13px] font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {editHost ? t('common.save') : t('conn.connect')}
          </button>
        </div>
      </aside>

      {keyWizardOpen && (
        <SshKeyWizard
          form={{
            name: form.name,
            address: form.address,
            port: form.port,
            username: form.username
          }}
          // Конец шага 1 мастера: форма сразу переключается на новый ключ (HM-12)
          onGenerated={(keyPath) => set({ authMethod: 'key', keyPath })}
          // Passphrase уходит тем же путём, что у существующих ключей:
          // поле секрета формы → keytar при сохранении хоста
          onPassphraseSaved={(passphrase) => set({ secret: passphrase })}
          onClose={() => setKeyWizardOpen(false)}
        />
      )}

      {deleteSecretConfirmOpen && (
        <ConfirmDialog
          title={t('conn.deleteSecretConfirm.title')}
          confirmLabel={t('conn.deleteSecretConfirm.confirm')}
          danger
          onConfirm={() => void deleteSecret()}
          onCancel={() => setDeleteSecretConfirmOpen(false)}
        >
          {t('conn.deleteSecretConfirm.body')}
        </ConfirmDialog>
      )}
    </div>
  );
}
