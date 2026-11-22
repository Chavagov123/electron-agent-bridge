'use strict';
// First import: the bridge must hook in before the app creates windows (off unless EAB_ENABLE=1).
// In Launch-mode tests the app stays unmodified: the launcher injects the bridge instead.
if (process.env.EAB_FIXTURE_MODE !== 'launch') require('@eab/electron/register');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView } = require('electron');
const { nameTarget } = require('@eab/electron');
const {
  announceReady,
  createFixtureWindow,
  handleCommands,
  runFixture,
} = require('@eab-fixtures/fixture-kit');

const file = (name) => path.join(__dirname, name);

/** Resolves once a <webview> guest has loaded; listening at app level cannot miss an early attach. */
function webviewLoaded() {
  return new Promise((resolve) => {
    app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() === 'webview') contents.once('did-finish-load', resolve);
    });
  });
}

runFixture(async () => {
  const guestLoaded = webviewLoaded();
  const main = await createFixtureWindow({
    file: file('index.html'),
    name: 'app-multi',
    extraWebPreferences: { webviewTag: true },
    deferReady: true,
  });

  const panel = new WebContentsView();
  main.contentView.addChildView(panel);
  panel.setBounds({ x: 0, y: 600, width: 1280, height: 200 });
  await panel.webContents.loadFile(file('panel.html'));

  // A hidden secondary window with an explicit name: its file name alone would say "settings".
  const settings = new BrowserWindow({ show: false, width: 600, height: 400, title: 'Settings' });
  nameTarget(settings.webContents, 'preferences');
  await settings.loadFile(file('settings.html'));

  await guestLoaded;
  handleCommands({
    // A window rendered offscreen (into frames the app reads, never shown).
    'open-offscreen': async () => {
      const offscreen = new BrowserWindow({
        show: false,
        width: 500,
        height: 300,
        webPreferences: { offscreen: true },
      });
      nameTarget(offscreen.webContents, 'render');
      await offscreen.loadFile(file('render.html'));
      return offscreen.webContents.getType();
    },
  });
  announceReady('app-multi');
});
