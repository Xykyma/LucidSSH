import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { TitleBar } from './components/chrome/TitleBar';
import { StatusBar } from './components/chrome/StatusBar';
import { HostPanel } from './components/HostManager/HostPanel';
import { NewConnectionDrawer } from './components/HostManager/NewConnectionDrawer';
import { QuickConnectDialog } from './components/HostManager/QuickConnectDialog';
import { SaveAsHostToast } from './components/HostManager/SaveAsHostToast';
import { TerminalArea } from './components/Terminal/TerminalArea';
import { FingerprintModal } from './components/Terminal/FingerprintModal';
import { CatalogPanel } from './components/CommandCatalog/CatalogPanel';
import { WelcomeScreen } from './components/Onboarding/WelcomeScreen';
import { FeatureGuide } from './components/Onboarding/FeatureGuide';
import { HelpScreen } from './components/Onboarding/HelpScreen';
import { WindowCloseGuard } from './components/Terminal/WindowCloseGuard';
import { ResizeDivider } from './components/common/ResizeDivider';
import { HistoryDrawer } from './components/History/HistoryDrawer';
import { SnippetSaveDialog } from './components/Snippets/SnippetSaveDialog';
import { SettingsScreen } from './components/Settings/SettingsScreen';
import { HostsProvider, useHosts } from './stores/hosts';
import { SessionsProvider, useSessions } from './stores/sessions';
import { ConfigProvider, useConfig } from './stores/config';
import { PanelsProvider, usePanels } from './stores/panels';
import { EventsProvider, useEvents } from './stores/events';
import { UpdatesProvider } from './stores/updates';
import { FIXED_HOTKEYS } from '@shared/hotkeys';
import { useHotkeys } from './hooks/useHotkeys';

/**
 * Welcome-экран показывается вместо основного UI, пока нет ни одного хоста
 * и onboarding не пройден (OB-01, OB-03); справка открывается из него и из
 * тайтл-бара (позже — по F1, HELP-02).
 */
function AppBody(): JSX.Element {
  const { hosts, loaded, openDrawer } = useHosts();
  const {
    hostKeyPrompt,
    answerHostKey,
    sessions,
    activeSessionId,
    connectQuick,
    saveAsHostPrompt,
    dismissSaveAsHostPrompt
  } = useSessions();
  const { config, update } = useConfig();
  const {
    historyOpen,
    snippetDialog,
    closeSnippetDialog,
    bumpSnippets,
    settingsOpen,
    openSettings,
    openHistory,
    guideOpen,
    openGuide,
    closeGuide,
    helpOpen,
    openHelp,
    quickConnectOpen,
    openQuickConnect,
    closeQuickConnect,
    openCatalogRequest
  } = usePanels();
  const { addFingerprintEvent } = useEvents();
  const [previewWelcome, setPreviewWelcome] = useState(false);

  // NOTIF-03: изменение отпечатка сервера попадает в ленту событий шапки.
  useEffect(() => {
    if (hostKeyPrompt?.isChanged) addFingerprintEvent(hostKeyPrompt.hostName);
  }, [hostKeyPrompt, addFingerprintEvent]);

  // Глобальные хоткеи (SET-01 Ctrl+, · SET-06/SET-10). Ctrl+F/поиск живёт в
  // TerminalArea. Биндинги читаются из config.hotkeys (кроме F1 — зафиксирован,
  // FIXED_HOTKEYS), а не сравниваются с буквальными клавишами — SET-10, issue #1.
  // Маршрутизация — через hotkeyBus (ADR-0012): отмену события берёт на себя
  // шина, здесь только «моё / не моё».
  useHotkeys('app-global', (combo) => {
    // ВРЕМЕННЫЙ dev-хук для визуальной проверки WelcomeScreen без удаления
    // хостов (пачка 9 дизайн-аудита) — import.meta.env.DEV вырезается
    // Vite-сборкой в проде (dead-code elimination), в упакованное
    // приложение не попадёт. Убрать после проверки.
    if (import.meta.env.DEV && combo === 'Ctrl+Shift+W') {
      setPreviewWelcome((v) => !v);
      return true;
    }
    if (combo === FIXED_HOTKEYS.help) {
      openHelp();
      return true;
    }
    const hk = config?.hotkeys;
    if (!hk) return false;
    if (combo === hk.openSettings) {
      openSettings();
      return true;
    }
    if (combo === hk.openHistory) {
      openHistory();
      return true;
    }
    if (combo === hk.quickConnect) {
      openQuickConnect();
      return true;
    }
    return false;
  });

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);
  const leftRef = useRef<HTMLElement>(null);
  const rightRef = useRef<HTMLElement>(null);

  const showWelcome = (loaded && hosts.length === 0) || previewWelcome;
  const leftWidth = config?.ui.leftPanelWidth ?? 220;
  const rightWidth = config?.ui.rightPanelWidth ?? 320;
  const catalogOpen = config?.ui.catalogPanelOpen ?? false;

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      {showWelcome ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <WelcomeScreen onAddFirst={() => openDrawer()} onOpenGuide={openGuide} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <HostPanel ref={leftRef} width={leftWidth} />
          <ResizeDivider
            side="left"
            targetRef={leftRef}
            min={160}
            max={340}
            onCommit={(w) => void update('ui.leftPanelWidth', w)}
          />
          <TerminalArea />
          {catalogOpen && sessions.length > 0 && (
            <>
              <ResizeDivider
                side="right"
                targetRef={rightRef}
                min={200}
                max={480}
                onCommit={(w) => void update('ui.rightPanelWidth', w)}
              />
              <CatalogPanel
                ref={rightRef}
                width={rightWidth}
                onClose={() => void update('ui.catalogPanelOpen', false)}
              />
            </>
          )}
        </div>
      )}
      <StatusBar />
      <NewConnectionDrawer />
      {quickConnectOpen && (
        <QuickConnectDialog onConnect={connectQuick} onClose={closeQuickConnect} />
      )}
      {saveAsHostPrompt && (
        <SaveAsHostToast
          prompt={saveAsHostPrompt}
          onSave={() => {
            openDrawer({ presetQuickConnect: saveAsHostPrompt });
            dismissSaveAsHostPrompt();
          }}
          onDismiss={dismissSaveAsHostPrompt}
        />
      )}
      {guideOpen && <FeatureGuide onClose={closeGuide} />}
      {helpOpen && <HelpScreen />}
      {hostKeyPrompt && (
        <FingerprintModal
          prompt={hostKeyPrompt}
          onAnswer={(decision) => void answerHostKey(decision)}
        />
      )}
      <WindowCloseGuard />
      {historyOpen && (
        <HistoryDrawer
          activeHostId={activeSession?.hostId}
          onOpenCatalog={(target) => {
            void update('ui.catalogPanelOpen', true);
            if (target) openCatalogRequest(target);
          }}
        />
      )}
      {settingsOpen && <SettingsScreen onOpenGuide={() => openHelp()} />}
      {snippetDialog && (
        <SnippetSaveDialog
          command={snippetDialog.command}
          editSnippet={snippetDialog.editSnippet}
          // sourceHost передан (сохранение из строки истории, решение 3
          // spec.md) — привязка к хосту строки, а не к активной вкладке;
          // не передан (терминал/редактирование из каталога) — как раньше.
          hostId={snippetDialog.sourceHost ? snippetDialog.sourceHost.hostId : activeSession?.hostId}
          hostName={
            snippetDialog.sourceHost ? snippetDialog.sourceHost.hostName : activeSession?.hostName
          }
          onSaved={() => {
            bumpSnippets();
            closeSnippetDialog();
          }}
          onClose={closeSnippetDialog}
        />
      )}
    </div>
  );
}

export default function App(): JSX.Element {
  return (
    <ConfigProvider>
      <HostsProvider>
        <SessionsProvider>
          <PanelsProvider>
            <EventsProvider>
              <UpdatesProvider>
                <AppBody />
              </UpdatesProvider>
            </EventsProvider>
          </PanelsProvider>
        </SessionsProvider>
      </HostsProvider>
    </ConfigProvider>
  );
}
