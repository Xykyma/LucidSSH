import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// Opt-in: needs a production build, a desktop and the Electron native-module ABI.
it.skipIf(process.env.LUCIDSSH_ELECTRON_TESTS !== '1')(
  'settings reset keeps the original live SSH session and terminal',
  async () => {
    const fixture = fileURLToPath(new URL('./resetSession.fixture.mjs', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [fixture], { timeout: 60000 });
    expect(stdout).toContain('PASS: settings reset keeps the original live session and terminal.');
  },
  65000
);
