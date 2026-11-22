'use strict';
// First import: the bridge must hook in before the app registers IPC or creates windows (off unless EAB_ENABLE=1).
// In Launch-mode tests the app stays unmodified: the launcher injects the bridge instead.
// The compatibility test swaps in an older runtime build (EAB_FIXTURE_RUNTIME: its dist/ directory).
if (process.env.EAB_FIXTURE_MODE !== 'launch') {
  const runtime = process.env.EAB_FIXTURE_RUNTIME;
  require(
    runtime ? require('node:path').join(runtime, 'register.cjs') : '@electron-agent-bridge/electron/register',
  );
}
const path = require('node:path');
const { createFixtureWindow, handleCommands, runFixture } = require('@eab-fixtures/fixture-kit');

runFixture(async () => {
  const window = await createFixtureWindow({ file: path.join(__dirname, 'index.html'), name: 'app-basic' });
  const page = (script) => window.webContents.executeJavaScript(script);
  handleCommands({
    // What the app (and any child process it spawns) can see of the session token.
    'env-token': () => process.env.EAB_TOKEN ?? null,
    // What a child process would inherit after a Launch-mode start, and whether a debug port is open.
    'launch-env': () => ({
      nodeOptions: process.env.NODE_OPTIONS ?? null,
      bridgeVariables: Object.keys(process.env).filter(
        (key) => key.startsWith('EAB_') && !key.startsWith('EAB_FIXTURE_'),
      ),
      inspectorUrl: require('node:inspector').url() ?? null,
      isPackaged: require('electron').app.isPackaged,
    }),
    // Typing changes a value without any DOM mutation.
    'type-customer': () => page("document.querySelector('#customer').value = 'Ann'"),
    'show-toast': () => page("document.querySelector('#toast').textContent = 'Saved'"),
    'rerender-save': () =>
      page("const save = document.querySelector('#save'); save.replaceWith(save.cloneNode(true)); true"),
    'show-toast-later': () =>
      page("setTimeout(() => { document.querySelector('#toast').textContent = 'Later' }, 300); true"),
    reload: () =>
      new Promise((resolve) => {
        window.webContents.once('did-finish-load', () => resolve(true));
        window.webContents.reload();
      }),
    // A user fills in and saves the order form with real (trusted) input from the OS side.
    'user-order': async () => {
      const centre = (selector) =>
        page(
          `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
        );
      const click = async (selector) => {
        const { x, y } = await centre(selector);
        for (const type of ['mouseDown', 'mouseUp']) {
          window.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      };
      // In the background the OS window stays where it is; the page still gets keyboard focus.
      if (process.env.FIXTURE_BACKGROUND !== '1') window.focus();
      window.webContents.focus();
      await click('#customer');
      for (const keyCode of 'Grace') window.webContents.sendInputEvent({ type: 'char', keyCode });
      await click('#gift');
      await click('#save');
      await new Promise((resolve) => setTimeout(resolve, 300));
      return page("document.querySelector('#orders').textContent");
    },
    // Page scripts run in the main world; the bridge's agent lives in an isolated world.
    'main-world-sees-agent': () => page("typeof globalThis.__eab !== 'undefined'"),
  });
});
