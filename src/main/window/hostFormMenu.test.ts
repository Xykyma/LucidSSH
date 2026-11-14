import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// Opt-in: needs a production build, Windows desktop and the Electron native-module ABI.
it.skipIf(process.env.LUCIDSSH_ELECTRON_TESTS !== '1' || process.platform !== 'win32')(
  'host form right-click opens a paste menu',
  async () => {
    const fixture = fileURLToPath(new URL('./hostFormMenu.fixture.mjs', import.meta.url));
    // In Node the electron package exports its executable path, not the Electron API.
    const electron: unknown = (await import('electron')).default;
    if (typeof electron !== 'string') throw new Error('Electron executable path unavailable');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(electron, [fixture], { env, timeout: 35000 });
    expect(stdout).toContain('PASS: host field right-click opens a context menu');
  },
  40000
);
