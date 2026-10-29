import { describe, expect, it } from 'vitest';
import { isAutoUpdateSupported } from './autoUpdateSupport';

describe('isAutoUpdateSupported', () => {
  it('win32 → true', () => expect(isAutoUpdateSupported('win32', {})).toBe(true));
  it('linux AppImage → true', () =>
    expect(isAutoUpdateSupported('linux', { APPIMAGE: '/x.AppImage' })).toBe(true));
  it('linux без APPIMAGE (.deb) → false', () => expect(isAutoUpdateSupported('linux', {})).toBe(false));
});
