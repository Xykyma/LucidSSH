// Real Electron regression fixture: build first, then run with Node (not Electron).
/* global process, setTimeout, clearTimeout, fetch, WebSocket, console */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;

const require = createRequire(import.meta.url);
const profile = mkdtempSync(join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'lucidssh-reset-'));
const key = utils.generateKeyPairSync('ed25519');
const keyPath = join(profile, 'test-key');
writeFileSync(keyPath, key.private, { mode: 0o600 });
writeFileSync(join(profile, 'config.json'), JSON.stringify({
  language: 'en', terminal: { fontSize: 24 }, guard: { globalEnabled: false }
}));
const clients = new Set();
let shellCount = 0;
const server = new Server({ hostKeys: [key.private] }, (client) => {
  clients.add(client);
  client.on('close', () => clients.delete(client));
  client.on('error', () => {});
  client.on('authentication', (ctx) => ctx.accept());
  client.on('ready', () => client.on('session', (accept) => {
    const session = accept();
    session.on('pty', (accept) => accept());
    session.on('window-change', (accept) => accept?.());
    session.on('exec', (_accept, reject) => reject());
    session.on('shell', (accept) => {
      shellCount++;
      const stream = accept();
      stream.write('reset-session-ready\r\n$ ');
      stream.on('data', (data) => {
        if (data.toString().includes('reset-after-ok')) stream.write('\r\nreset-after-ok\r\n$ ');
      });
    });
  }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const sshPort = server.address().port;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const electron = spawn(require('electron'), [
  resolve('.'), `--user-data-dir=${profile}`, '--remote-debugging-port=0'
], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let socket;
let seq = 0;
const pending = new Map();
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`CDP timeout: ${method}`));
  }, 5000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
  return result.result.value;
};
const wait = async (expression) => {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try { if (await evaluate(expression)) return; } catch { /* renderer navigation */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${expression}; page: ${JSON.stringify(await evaluate('({ url: location.href, bridge: !!window.lucidSSH, text: document.body?.innerText })'))}`);
};
const click = (label) => evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)});
  if (!button) throw new Error('Button not found: ' + ${JSON.stringify(label)});
  button.click();
})()`);

try {
  const origin = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Electron did not expose CDP: ' + output)), 20000);
    electron.stderr.on('data', (data) => {
      output += data.toString();
      const match = /DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)\//.exec(output);
      if (match) { clearTimeout(timeout); resolve(`http://${match[1]}`); }
    });
    electron.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Electron exited ${code}: ${output}`)); });
  });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    target = (await (await fetch(`${origin}/json/list`)).json()).find(t => t.type === 'page');
    if (!target) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(target, 'Electron page exists');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') console.error(JSON.stringify(message.params));
    if (message.method === 'Log.entryAdded') console.error(JSON.stringify(message.params));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('CDP socket closed'));
    }
    pending.clear();
  });
  await cdp('Runtime.enable');
  await cdp('Log.enable');
  await wait('!!window.lucidSSH && document.body.textContent.includes("Welcome to LucidSSH")');
  await evaluate(`(async () => {
    await window.lucidSSH.createHost({
      name: 'reset-test', address: '127.0.0.1', port: ${sshPort}, username: 'tester',
      authMethod: 'key', keyPath: ${JSON.stringify(keyPath)}, guardEnabled: true, historyEnabled: true
    });
  })()`);
  // Reload only during setup so HostsProvider reads the newly created fixture.
  await cdp('Page.reload');
  await wait('document.body.textContent.includes("reset-test")');
  await evaluate(`(() => {
    const row = document.querySelector('[draggable="true"]');
    if (!row) throw new Error('Host row missing');
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await wait('document.body.textContent.includes("Confirm and connect")');
  await click('Confirm and connect');
  await wait('(async () => (await window.lucidSSH.listSessions()).some(s => s.status === "connected"))()');
  await wait('document.querySelector(".xterm") && document.body.textContent.includes("reset-session-ready")');
  await evaluate(`window.__resetSentinel = document.querySelector('.xterm')`);
  const before = await evaluate('window.lucidSSH.listSessions()');
  console.log('Before reset:', JSON.stringify(before), 'shells:', shellCount);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', ctrlKey: true, bubbles: true }))`);
  await wait('document.body.textContent.includes("Reset to defaults")');
  await click('Reset to defaults');
  await wait('!!document.querySelector(\'[role="dialog"]\')');
  const resetLabel = await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].at(-1).textContent.trim()`);
  await click(resetLabel);
  await wait('!document.querySelector(\'[role="dialog"]\')');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = await evaluate(`(async () => ({
    sessions: await window.lucidSSH.listSessions(),
    terminals: document.querySelectorAll('.xterm').length,
    sameTerminal: window.__resetSentinel === document.querySelector('.xterm'),
    noActiveSession: document.body.textContent.includes('No active session'),
    outputPreserved: document.body.textContent.includes('reset-session-ready'),
    config: await window.lucidSSH.getConfig(),
    fontSize: document.querySelector('.xterm-char-measure-element')
      ? getComputedStyle(document.querySelector('.xterm-char-measure-element')).fontSize : null
  }))()`);
  console.log('After reset:', JSON.stringify({
    ...after, config: { fontSize: after.config.terminal.fontSize, guard: after.config.guard.globalEnabled }
  }), 'shells:', shellCount, 'connections:', clients.size);
  assert.deepEqual(after.sessions, before, 'Reset preserves the original live session');
  assert.ok(after.terminals > 0 && !after.noActiveSession, 'Live SSH session must remain visible after settings reset');
  assert.ok(after.sameTerminal && after.outputPreserved, 'Reset preserves the original terminal and its output');
  assert.equal(after.fontSize, `${after.config.terminal.fontSize}px`, 'Reset applies terminal defaults to the live xterm');
  assert.notEqual(after.config.terminal.fontSize, 24, 'Reset restores default font size');
  assert.equal(after.config.guard.globalEnabled, true, 'Reset re-enables Guard');
  assert.equal(shellCount, 1, 'Reset must not reconnect the shell');
  console.log('PASS: settings reset keeps the original live session and terminal.');
} finally {
  try {
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        await evaluate('(async () => { for (const s of await window.lucidSSH.listSessions()) await window.lucidSSH.destroySession(s.sessionId); })()');
      } catch { /* CDP timeout or process already exited: force cleanup below */ }
      socket.close();
    }
  } finally {
    electron.kill();
    for (const client of clients) client.end();
    server.close();
    unlinkSync(keyPath);
    console.log('Isolated fixture retained:', profile);
  }
}
