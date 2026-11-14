// Run in real Electron after npm run build; only a fresh disposable profile is used.
/* global process, console, setTimeout */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { app, Menu, clipboard } from 'electron';

const require = createRequire(import.meta.url);

const profile = mkdtempSync(join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'lucidssh-host-menu-'));
app.setPath('userData', profile);
app.setAppPath(resolve('.'));
writeFileSync(join(profile, 'config.json'), JSON.stringify({ language: 'en' }));
const menus = [];
const popup = Menu.prototype.popup;
Menu.prototype.popup = function (options) {
  menus.push(this);
  return popup.call(this, options);
};
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const clickNativeMenuItem = (label) => promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', `
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${process.pid})))
  $item = $items | Where-Object { $_.Current.Name -eq '${label}' }
  if (-not $item) { throw 'Native menu item missing' }
  Add-Type @'
  using System;
  using System.Runtime.InteropServices;
  public static class HostMenuMouse {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  }
'@
  $rect = $item.Current.BoundingRectangle
  [void][HostMenuMouse]::SetCursorPos([int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2))
  [HostMenuMouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [HostMenuMouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
`], { timeout: 5000 });
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const savedClipboard = {
      text: clipboard.readText(), html: clipboard.readHTML(),
      rtf: clipboard.readRTF(), image: clipboard.readImage()
    };
    let exitCode = 1;
    try {
      const js = async expression => {
        try { return await win.webContents.executeJavaScript(expression, true); }
        catch (error) {
          console.error('Expression:', expression, 'Page:', await win.webContents.executeJavaScript('document.body.innerText'));
          throw error;
        }
      };
      for (let n = 0; n < 100; n++) {
        if (await js(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Add first server')`)) break;
        await delay(50);
      }
      await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add first server').click()`);
      await delay(500);
      win.show();
      win.focus();
      const paste = async (id, text, select = false, caret) => {
        clipboard.writeText(text);
        const point = await js(`(() => {
          const input = document.getElementById(${JSON.stringify(id)});
          input.scrollIntoView({ block: 'center' });
          input.focus();
          ${select ? 'input.select();' : ''}
          ${caret !== undefined ? `input.setSelectionRange(${caret}, ${caret});` : ''}
          const r = input.getBoundingClientRect();
          let x = r.x + r.width / 2;
          ${caret !== undefined ? `
            const style = getComputedStyle(input);
            const context = document.createElement('canvas').getContext('2d');
            context.font = style.font;
            x = r.x + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)
              + context.measureText(input.value.slice(0, ${caret})).width - input.scrollLeft;
          ` : ''}
          return { x: Math.round(x), y: Math.round(r.y + r.height / 2) };
        })()`);
        const count = menus.length;
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...point });
        await delay(300);
        assert.equal(await js('document.activeElement.id'), id);
        assert.equal(menus.length, count + 1, `Right-click in #${id} must open a context menu`);
        const menu = menus.at(-1);
        assert.ok(menu.items.some(item => item.role === 'paste' && item.enabled), 'Native Paste is enabled');
        const before = await js(`(() => {
          const i = document.activeElement;
          return { value: i.value, start: i.selectionStart, end: i.selectionEnd, password: i.type === 'password' };
        })()`);
        if (select) assert.ok(before.end > before.start, 'Right-click preserves selection');
        if (caret !== undefined) assert.equal(before.start, caret, 'Right-click preserves the cursor');
        if (before.password) assert.equal(menu.items.find(item => item.role === 'copy').enabled, false);
        if (select && !before.password) assert.equal(menu.items.find(item => item.role === 'copy').enabled, true);
        await clickNativeMenuItem('Paste Ctrl+V');
        await delay(100);
        const expected = before.value.slice(0, before.start) + text + before.value.slice(before.end);
        assert.equal(await js(`document.getElementById(${JSON.stringify(id)}).value`),
          id === 'conn-port' ? expected.replace(/[^0-9]/g, '').slice(0, 5) : expected,
          `Native menu pastes at the cursor/selection in #${id}`);
        console.log(`PASS: ${id}, selection=${select}, password=${before.password}`);
      };
      await paste('conn-address', 'example.test');
      await paste('conn-address', 'replaced.test', true);
      await paste('conn-address', 'X', false, 3);
      await paste('conn-name', 'menu-test');
      await paste('conn-username', 'tester');
      await paste('conn-port', '2x2', true);
      await paste('conn-secret', 'fixture-only');
      // A forged UI hint must not let the native Copy role expose a password.
      await js(`document.querySelector('#conn-secret').select()`);
      clipboard.writeText('copy-guard-sentinel');
      await js(`window.lucidSSH.showHostFormMenu(true)`);
      await clickNativeMenuItem('Copy Ctrl+C');
      await delay(100);
      assert.equal(clipboard.readText(), 'copy-guard-sentinel', 'Chromium rejects copying a password even with a forged canCopy hint');
      await js(`[...document.querySelectorAll('[role="tab"]')].at(-1).click()`);
      await paste('conn-keypath', 'C:\\fixture-key');
      await paste('conn-passphrase', 'fixture-only', true);
      await paste('conn-jumphost', 'search');
      await js(`window.lucidSSH.createHost({
        name: 'edit-test', address: 'edit.test', port: 22, username: 'tester',
        authMethod: 'password', guardEnabled: true, historyEnabled: true
      })`);
      const loaded = once(win.webContents, 'did-finish-load');
      win.webContents.reload();
      await loaded;
      for (let n = 0; n < 100; n++) {
        if (await js(`!!document.querySelector('button[title="Edit"]')`)) break;
        await delay(50);
      }
      await js(`document.querySelector('button[title="Edit"]').click()`);
      await delay(300);
      await paste('conn-address', 'edited.test', true);
      await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save').click()`);
      await delay(200);
      assert.equal(await js(`(async () => (await window.lucidSSH.listHosts())[0].address)()`),
        'edited.test', 'Native paste updates React state and is saved when editing');
      await js(`document.querySelector('button[title="Edit"]').click()`);
      await delay(300);
      // A normal edit menu must not appear on the dialog background.
      const count = menus.length;
      const point = await js(`(() => { const r = document.querySelector('[data-host-form]').getBoundingClientRect(); return { x: Math.round(r.x + 10), y: 10 }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...point });
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...point });
      await delay(100);
      assert.equal(menus.length, count, 'No edit menu outside an editable host input');
      for (const property of ['readOnly', 'disabled']) {
        const point = await js(`(() => {
          const i = document.querySelector('#conn-address');
          i.${property} = true;
          const r = i.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`);
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...point });
        await delay(100);
        assert.equal(menus.length, count, `No edit menu for ${property} input`);
        await js(`document.querySelector('#conn-address').${property} = false`);
      }
      await js(`window.lucidSSH.i18nSetLanguage('ru')`);
      const ruPoint = await js(`(() => {
        const i = document.querySelector('#conn-address'); i.focus();
        const r = i.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...ruPoint });
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...ruPoint });
      await delay(100);
      assert.deepEqual(menus.at(-1).items.map(item => item.label), ['Копировать', 'Вставить']);
      console.log('PASS: host field right-click opens a context menu');
      exitCode = 0;
    } catch (error) {
      console.error(error);
    } finally {
      for (const menu of menus) menu.closePopup();
      clipboard.write(savedClipboard);
      app.exit(exitCode);
    }
  });
});
setTimeout(() => { console.error('Fixture timed out'); app.exit(1); }, 30000).unref();
require(resolve('out/main/index.js'));
