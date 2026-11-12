/**
 * Поддерживает ли сборка автообновление. Установленная Windows — да; portable
 * Windows (electron-builder задаёт PORTABLE_EXECUTABLE_DIR) — нет, portable exe
 * никогда не заменяет собственные файлы и обновляется вручную через Releases
 * (NFR-05, тикет 07); Linux — только AppImage (рантайм выставляет APPIMAGE),
 * `.deb` обновляется вручную через Releases.
 */
export function isAutoUpdateSupported(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform === 'win32') return !env.PORTABLE_EXECUTABLE_DIR;
  if (platform === 'linux') return Boolean(env.APPIMAGE);
  return false;
}
