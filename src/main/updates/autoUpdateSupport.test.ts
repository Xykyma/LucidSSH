import { describe, expect, it } from 'vitest';
import { isAutoUpdateSupported } from './autoUpdateSupport';

describe('isAutoUpdateSupported', () => {
  it('win32 установленная → true', () => expect(isAutoUpdateSupported('win32', {})).toBe(true));
  it('win32 dev — переменной portable нет → true', () =>
    expect(isAutoUpdateSupported('win32', {})).toBe(true));
  it('win32 portable (PORTABLE_EXECUTABLE_DIR) → false', () =>
    expect(isAutoUpdateSupported('win32', { PORTABLE_EXECUTABLE_DIR: 'D:\\usb' })).toBe(false));
  it('linux AppImage → true', () =>
    expect(isAutoUpdateSupported('linux', { APPIMAGE: '/x.AppImage' })).toBe(true));
  it('linux без APPIMAGE (.deb) → false', () => expect(isAutoUpdateSupported('linux', {})).toBe(false));
});
