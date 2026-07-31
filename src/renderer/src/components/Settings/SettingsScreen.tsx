import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppConfig } from '@shared/config';
import type { KnownHostView } from '@shared/ssh';
import type { ImportPreview } from '@shared/hosts';
import { ImportDialog } from '@/components/HostManager/ImportDialog';
import { ExternalImportDialog } from '@/components/HostManager/ExternalImportDialog';
import { useConfig, getCurrentConfig } from '@/stores/config';
import { usePanels } from '@/stores/panels';
import { useUpdates } from '@/stores/updates';
import { useSessions } from '@/stores/sessions';
import { applyTerminalConfig } from '@/components/Terminal/XtermView';
import { Card, Segment, SectionTitle, ToggleRow } from './controls';
import { Icon } from '@/components/common/Icon';
import { LogoMark } from '@/components/common/LogoMark';
import { useBackdropClose } from '@/hooks/useBackdropClose';

/**
 * Страница настроек (SET-01…08; Design_Brief §3.10; скриншот 08). Отдельная
 * полностраничная поверхность (не модалка), Ctrl+, или кнопка в панели хостов.
 * Разделы: Терминал, Подключение, Безопасность, Интерфейс, Горячие клавиши,
 * О программе. Запись немедленная (SET-07) — кнопки «Сохранить» нет.
 */

type Section = 'terminal' | 'connection' | 'security' | 'interface' | 'import' | 'hotkeys' | 'about';
const sectionKeys: Section[] = [
  'terminal',
  'connection',
  'security',
  'interface',
  'import',
  'hotkeys',
  'about'
];

const FONTS = ['JetBrains Mono', 'Fira Code', 'SF Mono', 'Cascadia Code'];
const SIZE_MAP: Record<'small' | 'medium' | 'large', number> = { small: 12, medium: 14, large: 16 };
function sizeKey(px: number): 'small' | 'medium' | 'large' {
  if (px <= 12) return 'small';
  if (px >= 15) return 'large';
  return 'medium';
}

export function SettingsScreen({ onOpenGuide }: { onOpenGuide: () => void }): JSX.Element {
  const { t } = useTranslation();
  const { config, update } = useConfig();
  const { closeSettings, settingsSection } = usePanels();
  const isSection = (v: string | null): v is Section =>
    v !== null && sectionKeys.includes(v as Section);
  const [section, setSection] = useState<Section>(
    isSection(settingsSection) ? settingsSection : 'interface'
  );
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const resetConfirmBackdrop = useBackdropClose(() => setResetConfirmOpen(false));

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeSettings();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeSettings]);

  // Настройки терминала применяем к живым сессиям сразу (SET-02).
  const updateTerminal = useCallback(
    async (path: string, value: string | number | boolean) => {
      await update(path, value);
      const c = getCurrentConfig();
      if (c) applyTerminalConfig(c);
    },
    [update]
  );

  const doReset = async (): Promise<void> => {
    await window.lucidSSH.resetConfig();
    setResetConfirmOpen(false);
    // Перечитываем конфиг из main через полную перезагрузку окна — проще и надёжнее,
    // чем ре-инициализировать все сторы.
    window.location.reload();
  };

  if (!config) return <div className="fixed inset-0 z-50 bg-bg-base" />;

  const sections: { k: Section; label: string }[] = [
    { k: 'interface', label: t('settings.sections.interface') },
    { k: 'terminal', label: t('settings.sections.terminal') },
    { k: 'connection', label: t('settings.sections.connection') },
    { k: 'security', label: t('settings.sections.security') },
    { k: 'import', label: t('settings.sections.import') },
    { k: 'hotkeys', label: t('settings.sections.hotkeys') },
    { k: 'about', label: t('settings.sections.about') }
  ];

  return (
    <div className="animate-[esh-fade_.15s_ease] fixed inset-0 z-50 flex flex-col bg-bg-base">
      {/* Шапка */}
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-border-default px-[22px]">
        <div className="flex items-center gap-[11px]">
          <Icon name="settings" size={18} className="text-lavender" />
          <span className="text-[16px] font-semibold text-text-strong">{t('settings.title')}</span>
          <span className="rounded-[4px] border border-[rgba(255,255,255,0.1)] px-[7px] py-[2px] font-mono text-[11px] text-text-dim">
            Ctrl + ,
          </span>
        </div>
        <button
          type="button"
          aria-label={t('common.close')}
          onClick={closeSettings}
          className="flex size-[26px] items-center justify-center rounded-[5px] text-text-muted hover:bg-bg-elevated hover:text-text-strong"
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Навигация */}
        <nav className="flex w-[200px] shrink-0 flex-col gap-[3px] border-r border-border-default px-3 pt-[14px]">
          {sections.map((s) => (
            <button
              key={s.k}
              type="button"
              onClick={() => setSection(s.k)}
              className={`block w-full rounded-[5px] px-3 py-2 text-left text-[13px] ${
                section === s.k
                  ? 'bg-bg-elevated-2 font-medium text-text-strong'
                  : 'text-text-muted hover:text-text-strong'
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>

        {/* Контент */}
        <div className="min-h-0 flex-1 overflow-y-auto px-[28px] py-[24px]">
          <div className="mx-auto flex max-w-[620px] flex-col gap-[14px]">
            {section === 'terminal' && (
              <TerminalSection config={config} update={update} updateTerminal={updateTerminal} />
            )}
            {section === 'connection' && <ConnectionSection config={config} update={update} />}
            {section === 'security' && <SecuritySection config={config} update={update} />}
            {section === 'interface' && <InterfaceSection config={config} update={update} />}
            {section === 'import' && <ImportSection />}
            {section === 'hotkeys' && <HotkeysSection />}
            {section === 'about' && <AboutSection onOpenGuide={onOpenGuide} />}
          </div>
        </div>
      </div>

      {/* Footer: сброс до заводских (SET-08) — виден для любого раздела */}
      <div className="flex shrink-0 items-center justify-between gap-[14px] border-t border-border-default px-[28px] py-[10px]">
        <div className="text-[11.5px] text-text-dim">{t('settings.footer', { version: config.version })}</div>
        <button
          type="button"
          onClick={() => setResetConfirmOpen(true)}
          className="h-[30px] shrink-0 rounded-[6px] border border-danger/30 px-[13px] text-[12px] text-danger-text hover:bg-danger/10"
        >
          {t('settings.about.resetBtn')}
        </button>
      </div>

      {resetConfirmOpen && (
        <div
          className="animate-[esh-fade_.12s_ease] fixed inset-0 z-[60] flex items-center justify-center bg-black/70"
          {...resetConfirmBackdrop}
          role="presentation"
        >
          <div
            className="animate-[esh-pop_.15s_ease] w-[420px] max-w-[92%] rounded-[8px] border border-border-strong bg-bg-panel px-[22px] py-5"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="text-[15px] font-semibold text-text-strong">
              {t('settings.about.reset')}
            </div>
            <div className="mt-[9px] text-[12.5px] leading-[1.55] text-text-muted">
              {t('settings.about.resetDesc')}
            </div>
            <div className="mt-[18px] flex justify-end gap-[9px]">
              <button
                type="button"
                onClick={() => setResetConfirmOpen(false)}
                className="h-8 rounded-[6px] bg-bg-elevated px-[15px] text-[12.5px] text-text-body hover:bg-bg-elevated-2"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void doReset()}
                className="h-8 rounded-[6px] bg-danger px-[15px] text-[12.5px] font-medium text-white hover:brightness-110"
              >
                {t('settings.about.resetConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type UpdateFn = (path: string, value: string | number | boolean) => Promise<void>;

function TerminalSection({
  config,
  update,
  updateTerminal
}: {
  config: AppConfig;
  update: UpdateFn;
  updateTerminal: UpdateFn;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <SectionTitle>{t('settings.sections.terminal')}</SectionTitle>
      <Card title={t('settings.terminal.font')}>
        <div className="flex flex-wrap gap-[7px]">
          {FONTS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => void updateTerminal('terminal.font', f)}
              className={`rounded-[4px] px-[11px] py-[5px] font-mono text-[12px] ${
                config.terminal.font === f
                  ? 'bg-accent text-white'
                  : 'border border-border-default bg-bg-base text-text-muted hover:text-text-strong'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </Card>

      <Card title={t('settings.terminal.fontSize')}>
        <Segment
          value={sizeKey(config.terminal.fontSize)}
          onChange={(k) => void updateTerminal('terminal.fontSize', SIZE_MAP[k])}
          options={[
            { key: 'small', label: t('settings.terminal.sizeSmall') },
            { key: 'medium', label: t('settings.terminal.sizeMedium') },
            { key: 'large', label: t('settings.terminal.sizeLarge') }
          ]}
        />
      </Card>

      <ToggleRow
        title={t('settings.terminal.bell')}
        desc={t('settings.terminal.bellDesc')}
        on={config.terminal.bell === 'sound'}
        onChange={(v) => void update('terminal.bell', v ? 'sound' : 'off')}
      />
      <ToggleRow
        title={t('settings.terminal.brightBold')}
        desc={t('settings.terminal.brightBoldDesc')}
        on={config.terminal.brightBold}
        onChange={(v) => void updateTerminal('terminal.brightBold', v)}
      />
      <ToggleRow
        title={t('settings.terminal.selectCopy')}
        desc={t('settings.terminal.selectCopyDesc')}
        on={config.terminal.selectToCopy}
        onChange={(v) => void update('terminal.selectToCopy', v)}
      />
      <ToggleRow
        title={t('settings.terminal.rightPaste')}
        desc={t('settings.terminal.rightPasteDesc')}
        on={config.terminal.rightClickPaste}
        onChange={(v) => void update('terminal.rightClickPaste', v)}
      />

      {/* Тип эмуляции — зафиксирован в 1.0, выбор заблокирован (SET-02) */}
      <div className="flex items-center justify-between gap-[14px] rounded-[8px] border border-border-default bg-bg-panel px-[17px] py-[14px] opacity-60">
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold text-text-strong">
            {t('settings.terminal.emulationType')}
          </div>
          <div className="mt-[3px] text-[12px] text-text-muted">
            {t('settings.terminal.emulationDesc')}
          </div>
        </div>
        <div className="shrink-0 rounded-[5px] border border-border-default bg-bg-base px-[11px] py-[6px] font-mono text-[12.5px] text-text-muted">
          xterm-256color ▾
        </div>
      </div>
    </>
  );
}

function ConnectionSection({ config, update }: { config: AppConfig; update: UpdateFn }): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <SectionTitle>{t('settings.sections.connection')}</SectionTitle>
      <NumberCard
        title={t('settings.connection.keepalive')}
        desc={t('settings.connection.keepaliveDesc')}
        value={config.connection.keepaliveIntervalSec}
        min={5}
        max={3600}
        unit={t('settings.connection.seconds')}
        onCommit={(n) => void update('connection.keepaliveIntervalSec', n)}
      />
      <NumberCard
        title={t('settings.connection.timeout')}
        desc={t('settings.connection.timeoutDesc')}
        value={config.connection.connectTimeoutSec}
        min={3}
        max={120}
        unit={t('settings.connection.seconds')}
        onCommit={(n) => void update('connection.connectTimeoutSec', n)}
      />
      <ToggleRow
        title={t('settings.connection.autoreconnect')}
        desc={t('settings.connection.autoreconnectDesc')}
        on={config.connection.autoreconnect}
        onChange={(v) => void update('connection.autoreconnect', v)}
      />
    </>
  );
}

function NumberCard({
  title,
  desc,
  value,
  min,
  max,
  unit,
  onCommit
}: {
  title: string;
  desc: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  onCommit: (n: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (): void => {
    const n = parseInt(draft, 10);
    if (Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, n)));
    else setDraft(String(value));
  };
  return (
    <div className="flex items-center justify-between gap-[14px] rounded-[8px] border border-border-default bg-bg-panel px-[17px] py-[15px]">
      <div className="min-w-0">
        <div className="text-[13.5px] font-semibold text-text-strong">{title}</div>
        <div className="mt-[3px] text-[12px] text-text-muted">{desc}</div>
      </div>
      <div className="flex shrink-0 items-center gap-[7px]">
        <input
          type="number"
          value={draft}
          min={min}
          max={max}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
          className="w-[64px] rounded-[5px] border border-[rgba(255,255,255,0.12)] bg-bg-base px-[9px] py-[7px] text-center font-mono text-[13px] text-text-strong outline-none focus:border-accent"
        />
        {unit && <span className="text-[12px] text-text-muted">{unit}</span>}
      </div>
    </div>
  );
}

function SecuritySection({ config, update }: { config: AppConfig; update: UpdateFn }): JSX.Element {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<KnownHostView[]>([]);
  const refresh = useCallback(() => void window.lucidSSH.listKnownHosts().then(setHosts), []);
  useEffect(() => refresh(), [refresh]);

  return (
    <>
      <SectionTitle>{t('settings.sections.security')}</SectionTitle>
      <ToggleRow
        title={t('settings.security.guard')}
        desc={t('settings.security.guardDesc')}
        on={config.guard.globalEnabled}
        onChange={(v) => void update('guard.globalEnabled', v)}
      />

      <ToggleRow
        title={t('settings.security.history')}
        desc={t('settings.security.historyDesc')}
        on={config.history.enabled}
        onChange={(v) => void update('history.enabled', v)}
      />

      <div className="rounded-[8px] border border-border-default bg-bg-panel px-[17px] py-[15px]">
        <div className="mb-[3px] text-[13.5px] font-semibold text-text-strong">
          {t('settings.security.knownHosts')}
        </div>
        <div className="mb-[12px] text-[12px] text-text-muted">
          {t('settings.security.knownHostsDesc')}
        </div>
        {hosts.length === 0 ? (
          <div className="py-5 text-center text-[12px] text-text-dim">
            {t('settings.security.knownEmpty')}
          </div>
        ) : (
          <div className="flex flex-col gap-[7px]">
            {hosts.map((h) => (
              <div
                key={h.line}
                className="flex items-center gap-3 rounded-[6px] border border-[rgba(255,255,255,0.07)] bg-bg-base px-3 py-[9px]"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] text-text-strong">{h.name ?? h.host}</div>
                  <div className="truncate font-mono text-[11px] text-text-dim">
                    {h.name ? `${h.host} · ` : ''}
                    {h.keyType} · {h.fingerprint}
                  </div>
                </div>
                <button
                  type="button"
                  title={t('settings.security.knownDelete')}
                  onClick={() => void window.lucidSSH.deleteKnownHost(h.line).then(refresh)}
                  className="h-[26px] shrink-0 rounded-[5px] bg-danger/10 px-[11px] text-[11.5px] text-danger-text hover:bg-danger/20"
                >
                  {t('settings.security.knownDelete')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

    </>
  );
}

/** Импорт хостов (Design_Brief §3.6, решение 11.07.2026): внешние источники
 *  (PuTTY, ~/.ssh/config — HM-03/HM-04) и собственный JSON-формат LucidSSH
 *  (EXP-01…04) — карточка JSON раньше жила в «Безопасности», перенесена сюда,
 *  т.к. про импорт списка хостов, а не про безопасность. Список внешних
 *  источников расширяется по мере реализации HM-09, HM-10. */
function ImportSection(): JSX.Element {
  const { t } = useTranslation();
  const [extImportOpen, setExtImportOpen] = useState(false);
  const [importState, setImportState] = useState<{ json: string; preview: ImportPreview } | null>(
    null
  );
  const [importError, setImportError] = useState(false);
  const pickImport = async (): Promise<void> => {
    setImportError(false);
    try {
      const res = await window.lucidSSH.pickImportHosts();
      if (res) setImportState(res);
    } catch {
      setImportError(true);
    }
  };

  return (
    <>
      <SectionTitle>{t('settings.sections.import')}</SectionTitle>

      <Card title={t('settings.import.external')}>
        <div className="mb-2 text-[12px] text-text-muted">{t('settings.import.externalDesc')}</div>
        <button
          type="button"
          onClick={() => setExtImportOpen(true)}
          className="flex h-[32px] items-center gap-2 rounded-[6px] border border-[rgba(255,255,255,0.12)] bg-bg-elevated-2 px-3 text-[12.5px] font-medium text-text-strong hover:border-accent"
        >
          <Icon name="download" size={14} /> {t('settings.import.externalBtn')}
        </button>
      </Card>

      <Card title={t('settings.security.hostData')}>
        <div className="mb-2 text-[12px] text-text-muted">{t('settings.security.hostDataDesc')}</div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void window.lucidSSH.exportHosts()}
            className="flex h-[32px] items-center gap-2 rounded-[6px] border border-[rgba(255,255,255,0.12)] bg-bg-elevated-2 px-3 text-[12.5px] font-medium text-text-strong hover:border-accent"
          >
            <Icon name="upload" size={14} /> {t('settings.security.exportHosts')}
          </button>
          <button
            type="button"
            onClick={() => void pickImport()}
            className="flex h-[32px] items-center gap-2 rounded-[6px] border border-[rgba(255,255,255,0.12)] bg-bg-elevated-2 px-3 text-[12.5px] font-medium text-text-strong hover:border-accent"
          >
            <Icon name="download" size={14} /> {t('settings.security.importHosts')}
          </button>
        </div>
        <div className="mt-2 text-[11.5px] text-text-dim">
          {t('settings.security.hostDataKeyHint')}
        </div>
        {importError && (
          <div className="mt-2 text-[11.5px] text-danger-text">{t('hosts.import.invalidFile')}</div>
        )}
      </Card>

      {extImportOpen && <ExternalImportDialog onClose={() => setExtImportOpen(false)} />}

      {importState && (
        <ImportDialog
          json={importState.json}
          preview={importState.preview}
          onClose={() => setImportState(null)}
        />
      )}
    </>
  );
}

const LANGUAGE_LABELS: Record<string, string> = { ru: 'Русский', en: 'English' };

function LanguageCard(): JSX.Element {
  const { t, i18n } = useTranslation();
  const [languages, setLanguages] = useState<string[]>([]);

  useEffect(() => {
    void window.lucidSSH.i18nListLanguages().then(setLanguages);
  }, []);

  const setLanguage = async (lng: string): Promise<void> => {
    await window.lucidSSH.i18nSetLanguage(lng);
    await i18n.changeLanguage(lng);
  };

  if (languages.length < 2) return <></>;

  return (
    <Card title={t('settings.interface.language')}>
      <Segment
        value={i18n.language}
        onChange={(lng) => void setLanguage(lng)}
        options={languages.map((lng) => ({ key: lng, label: LANGUAGE_LABELS[lng] ?? lng }))}
      />
    </Card>
  );
}

function InterfaceSection({ config, update }: { config: AppConfig; update: UpdateFn }): JSX.Element {
  const { t } = useTranslation();
  const { resetHints } = useConfig();
  const h = config.ui.hints;
  const expertActive = config.ui.expertMode;

  const enableExpert = async (): Promise<void> => {
    await update('ui.expertMode', true);
    await update('ui.hints.commandCatalog', false);
    await update('ui.hints.outputTooltips', false);
    await update('ui.hints.errorPanel', false);
    await update('ui.hints.connectionDialog', false);
  };
  const enableAllUi = async (): Promise<void> => {
    await update('ui.expertMode', false);
    await update('ui.hints.commandCatalog', true);
    await update('ui.hints.outputTooltips', true);
    await update('ui.hints.errorPanel', true);
    await update('ui.hints.connectionDialog', true);
  };
  return (
    <>
      <LanguageCard />

      <div className="mb-[2px] flex items-start justify-between gap-[14px]">
        <div>
          <SectionTitle>{t('settings.sections.interface')}</SectionTitle>
          <div className="mt-[5px] max-w-[380px] text-[12px] leading-[1.5] text-text-muted">
            {t('settings.interface.expertDesc')}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void (expertActive ? enableAllUi() : enableExpert())}
          className="flex h-8 shrink-0 items-center gap-[7px] rounded-[6px] border border-[rgba(255,255,255,0.12)] bg-bg-elevated-2 pr-[14px] pl-[10px] text-[12.5px] font-medium text-text-strong hover:border-accent"
        >
          <span
            className={
              expertActive
                ? 'size-[7px] shrink-0 rounded-full bg-lavender-light'
                : 'size-[7px] shrink-0 rounded-full bg-text-dim'
            }
          />
          {t('settings.interface.expert')} · {expertActive ? t('settings.interface.expertOn') : t('settings.interface.expertOff')}
        </button>
      </div>

      <ToggleRow
        title={t('settings.interface.hintCatalog')}
        desc={t('settings.interface.hintCatalogDesc')}
        on={h.commandCatalog}
        onChange={(v) => void update('ui.hints.commandCatalog', v)}
      />
      <ToggleRow
        title={t('settings.interface.hintTooltips')}
        desc={t('settings.interface.hintTooltipsDesc')}
        on={h.outputTooltips}
        onChange={(v) => void update('ui.hints.outputTooltips', v)}
      />
      <ToggleRow
        title={t('settings.interface.hintError')}
        desc={t('settings.interface.hintErrorDesc')}
        on={h.errorPanel}
        onChange={(v) => void update('ui.hints.errorPanel', v)}
      />
      <ToggleRow
        title={t('settings.interface.hintConnect')}
        desc={t('settings.interface.hintConnectDesc')}
        on={h.connectionDialog}
        onChange={(v) => void update('ui.hints.connectionDialog', v)}
      />

      <div className="text-[11.5px] text-text-dim">
        <button
          type="button"
          onClick={() => void resetHints()}
          className="text-lavender hover:underline"
        >
          {t('settings.interface.resetHintsLink')}
        </button>{' '}
        {t('settings.interface.resetHintsNote')}
      </div>

      <SectionTitle>{t('settings.interface.notifications')}</SectionTitle>
      <ToggleRow
        title={t('settings.interface.systemToasts')}
        desc={t('settings.interface.systemToastsDesc')}
        on={config.ui.notifications.systemToasts}
        onChange={(v) => void update('ui.notifications.systemToasts', v)}
      />
      <NumberCard
        title={t('settings.interface.longCommand')}
        desc={t('settings.interface.longCommandDesc')}
        value={config.ui.notifications.longCommandThresholdSec}
        min={0}
        max={86400}
        unit={t('settings.connection.seconds')}
        onCommit={(n) => void update('ui.notifications.longCommandThresholdSec', n)}
      />
    </>
  );
}

interface Hotkey {
  keys: string;
  action: string;
}

function HotkeysSection(): JSX.Element {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const all: Hotkey[] = useMemo(
    () => [
      { keys: 'Ctrl + K', action: t('settings.hk.quickConnect') },
      { keys: 'Ctrl + ,', action: t('settings.hk.openSettings') },
      { keys: 'Ctrl + H', action: t('settings.hk.openHistory') },
      { keys: 'Ctrl + L', action: t('settings.hk.openCatalog') },
      { keys: 'Ctrl + 0', action: t('settings.hk.toggleHostPanel') },
      { keys: 'Ctrl + Space', action: t('settings.hk.snippetPalette') },
      { keys: 'Ctrl + F', action: t('settings.hk.search') },
      { keys: 'Ctrl + W', action: t('settings.hk.closeTab') },
      { keys: 'Ctrl + Shift + C', action: t('settings.hk.copy') },
      { keys: 'Ctrl + Shift + V', action: t('settings.hk.paste') },
      { keys: 'Esc', action: t('settings.hk.closePanel') },
      { keys: 'F1', action: t('settings.hk.guide') }
    ],
    [t]
  );
  const query = q.trim().toLowerCase();
  const rows = all.filter(
    (r) => !query || r.action.toLowerCase().includes(query) || r.keys.toLowerCase().includes(query)
  );

  return (
    <>
      <SectionTitle>{t('settings.sections.hotkeys')}</SectionTitle>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('settings.hk.searchPlaceholder')}
        className="h-9 w-full rounded-[6px] border border-[rgba(255,255,255,0.12)] bg-bg-panel px-3 text-[13px] text-text-strong outline-none placeholder:text-text-dim focus:border-accent"
      />
      <div className="overflow-hidden rounded-[8px] border border-border-default bg-bg-panel">
        {rows.length === 0 ? (
          <div className="py-[26px] text-center text-[12.5px] text-text-dim">
            {t('settings.hk.noMatches')}
          </div>
        ) : (
          rows.map((r) => (
            <div
              key={r.keys}
              className="flex items-center justify-between gap-[14px] border-b border-[rgba(255,255,255,0.05)] px-4 py-[11px] last:border-b-0"
            >
              <span className="text-[13px] text-text-body">{r.action}</span>
              <span className="shrink-0 rounded-[5px] border border-[rgba(255,255,255,0.1)] bg-bg-base px-[9px] py-[3px] font-mono text-[12px] text-text-muted">
                {r.keys}
              </span>
            </div>
          ))
        )}
      </div>
      <div className="text-[11.5px] text-text-dim">{t('settings.hk.readOnlyNote')}</div>
    </>
  );
}

function AboutSection({ onOpenGuide }: { onOpenGuide: () => void }): JSX.Element {
  const { t } = useTranslation();
  const { config, update } = useConfig();
  const { status, check, download, install } = useUpdates();
  const { sessions } = useSessions();
  const [confirmInstall, setConfirmInstall] = useState(false);

  const activeCount = sessions.filter(
    (s) => s.status === 'connected' || s.status === 'connecting' || s.status === 'reconnecting'
  ).length;
  const updateState = status?.state ?? 'idle';
  const busy = updateState === 'checking' || updateState === 'downloading';

  const statusLine = ((): string | null => {
    if (status?.notConfigured) return null; // не загромождаем компактную карточку в dev
    switch (updateState) {
      case 'checking':
        return t('settings.updates.checking');
      case 'available':
        return t('settings.updates.available', { version: status?.info?.version ?? '' });
      case 'downloading':
        return t('settings.updates.downloading', { percent: Math.round(status?.progress?.percent ?? 0) });
      case 'downloaded':
        return t('settings.updates.downloaded', { version: status?.info?.version ?? '' });
      case 'error':
        return t('settings.updates.error');
      default:
        return null;
    }
  })();

  const updateLabel =
    updateState === 'available'
      ? t('settings.updates.download')
      : updateState === 'downloaded'
        ? t('settings.updates.install')
        : t('settings.updates.check');
  const onUpdateClick = (): void => {
    if (updateState === 'available') void download();
    else if (updateState === 'downloaded') setConfirmInstall(true);
    else void check();
  };

  return (
    <>
      <SectionTitle>{t('settings.sections.about')}</SectionTitle>

      {/* Лого + версия + проверка обновлений — одна компактная карточка, как в макете */}
      <div className="flex flex-col rounded-[8px] border border-border-default bg-bg-panel">
        <div className="flex items-center gap-[15px] px-[18px] py-5">
          <div className="flex size-[72px] shrink-0 items-center justify-center">
            <LogoMark size={72} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-semibold text-text-primary">LucidSSH</div>
            <div className="mt-[2px] text-[12.5px] text-text-muted">
              {t('settings.about.versionOs', { version: config?.version ?? '—' })}
            </div>
            <div className="mt-1 text-[12px] text-text-dim">{t('settings.about.tagline')}</div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onUpdateClick}
            className="h-[34px] shrink-0 rounded-[6px] border border-[rgba(255,255,255,0.12)] bg-bg-elevated-2 px-[14px] text-[12.5px] font-medium text-text-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {updateLabel}
          </button>
        </div>
        {(statusLine || confirmInstall) && (
          <div className="border-t border-[rgba(255,255,255,0.06)] px-[18px] py-[12px]">
            {statusLine && <div className="text-[11.5px] text-text-dim">{statusLine}</div>}
            {confirmInstall && (
              <div
                className={`rounded-[6px] border border-warning/25 bg-warning/10 px-3 py-2 ${statusLine ? 'mt-2' : ''}`}
              >
                <div className="text-[11.5px] text-warning-text">
                  {activeCount > 0
                    ? t('settings.updates.installWarnSessions', { count: activeCount })
                    : t('settings.updates.installWarn')}
                </div>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void install()}
                    className="h-[30px] rounded-[6px] bg-accent px-3 text-[12px] font-medium text-white hover:bg-accent-hover"
                  >
                    {t('settings.updates.installNow')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmInstall(false)}
                    className="h-[30px] rounded-[6px] bg-bg-tab-active px-3 text-[12px] text-text-body hover:text-text-strong"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* SET-09: ссылки на GitHub — все открываются в системном браузере (SEC-08) */}
      <div className="flex items-center gap-[14px] px-[2px] text-[12px]">
        <button
          type="button"
          onClick={() => window.lucidSSH.openBugReport()}
          className="text-lavender hover:underline"
        >
          {t('settings.about.reportBug')}
        </button>
        <span className="text-text-dim">·</span>
        <button
          type="button"
          onClick={() => window.lucidSSH.openFeatureRequest()}
          className="text-lavender hover:underline"
        >
          {t('settings.about.requestFeature')}
        </button>
        <span className="text-text-dim">·</span>
        <button
          type="button"
          onClick={() => window.lucidSSH.openReleasesPage()}
          className="text-lavender hover:underline"
        >
          {t('settings.about.changelog')}
        </button>
      </div>

      {/* §9.1 Release_and_Update_Strategy.md: спокойное объяснение отсутствия
          подписи вместо предупреждения в окне первого запуска (BLK-01 закрыт
          решением от 08.07.2026 — сертификат недоступен разработчикам из РФ). */}
      <div className="flex items-start gap-2 rounded-[8px] border border-border-default bg-bg-panel px-[17px] py-[13px]">
        <Icon name="shield" size={14} className="mt-[1px] shrink-0 text-text-dim" />
        <div className="text-[11.5px] leading-[1.5] text-text-dim">
          {t('settings.about.noSignature')}{' '}
          <button
            type="button"
            onClick={() => window.lucidSSH.openReleasesPage()}
            className="text-lavender hover:underline"
          >
            {t('settings.about.noSignatureLink')}
          </button>
        </div>
      </div>

      <ToggleRow
        title={t('settings.updates.autoCheck')}
        desc={t('settings.updates.autoCheckDesc')}
        on={config?.updates.autoCheck ?? true}
        onChange={(v) => void update('updates.autoCheck', v)}
      />

      <button
        type="button"
        onClick={onOpenGuide}
        className="flex items-center gap-[13px] rounded-[8px] border border-border-default bg-bg-panel px-[17px] py-[14px] text-left hover:border-accent"
      >
        <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[8px] bg-accent/[0.14] text-lavender-light">
          <Icon name="help" size={17} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold text-text-strong">
            {t('settings.about.help')}
          </span>
          <span className="mt-[2px] block text-[12px] text-text-muted">
            {t('settings.about.guideDesc')}
          </span>
        </span>
        <span className="shrink-0 text-[18px] text-text-dim">›</span>
      </button>

      {/* Заглушки — реального контента (лицензия/зависимости/сайт) пока нет */}
      <div className="flex gap-[18px] px-1">
        <span className="text-[12px] text-lavender hover:underline">
          {t('settings.about.licenseLink')}
        </span>
        <span className="text-[12px] text-lavender hover:underline">
          {t('settings.about.openSource')}
        </span>
        <span className="text-[12px] text-lavender hover:underline">
          {t('settings.about.website')}
        </span>
      </div>
    </>
  );
}
