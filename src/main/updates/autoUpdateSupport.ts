/**
 * Поддерживает ли сборка автообновление. Windows — да; Linux — только AppImage
 * (рантайм выставляет APPIMAGE), `.deb` обновляется вручную через Releases.
 */
export function isAutoUpdateSupported(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform === 'win32') return true;
  if (platform === 'linux') return Boolean(env.APPIMAGE);
  return false;
}
