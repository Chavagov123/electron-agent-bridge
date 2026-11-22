'use strict';
// First: the bridge (off unless EAB_ENABLE=1), with the devtools shim on so devtools-enabled stores
// register themselves. FIXTURE_EVAL=1 raises the ceiling to `eval`. In Launch-mode tests the launcher
// injects the bridge instead (no shim; `eval` through allowEval).
if (process.env.EAB_FIXTURE_MODE !== 'launch') {
  require('@eab/electron').enableAgentBridge({
    state: { devtoolsShim: true },
    ...(process.env.FIXTURE_EVAL === '1' ? { capabilities: ['observe', 'interact', 'eval'] } : {}),
  });
}
const path = require('node:path');
const { BrowserWindow, Menu, dialog } = require('electron');
const { createFixtureWindow, handleCommands, runFixture } = require('@eab-fixtures/fixture-kit');

// What the app did, for the tests: answers it got from dialogs, windows it opened.
const digest = { opened: [], saved: [], asked: [] };
const pristine = {
  showOpenDialog: dialog.showOpenDialog,
  showOpenDialogSync: dialog.showOpenDialogSync,
  showMessageBox: dialog.showMessageBox,
  showMessageBoxSync: dialog.showMessageBoxSync,
};

function buildMenu(window) {
  return Menu.buildFromTemplate([
    {
      label: '&File',
      submenu: [
        {
          id: 'file.open',
          label: 'Open…',
          click: async () => {
            digest.opened.push(await dialog.showOpenDialog(window, { properties: ['openFile'] }));
          },
        },
        {
          label: 'Save As…',
          click: () => {
            digest.saved.push(dialog.showSaveDialogSync(window, {}));
          },
        },
        { label: 'Export', enabled: false, click: () => undefined },
        { type: 'separator' },
        {
          label: 'Ask',
          click: () => {
            digest.asked.push(
              dialog.showMessageBoxSync(window, { message: 'Sure?', buttons: ['No', 'Yes'] }),
            );
          },
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'New Window',
          click: () => {
            const extra = new BrowserWindow({ width: 400, height: 300, title: 'extra', show: false });
            void extra.loadURL('data:text/html,<title>extra</title>');
          },
        },
      ],
    },
  ]);
}

runFixture(async () => {
  const window = await createFixtureWindow({ file: path.join(__dirname, 'index.html'), name: 'app-state' });
  Menu.setApplicationMenu(buildMenu(window));
  handleCommands({
    digest: () => digest,
    // Dialog functions are Electron's own again (stubs restored).
    'dialogs-pristine': () => Object.entries(pristine).every(([name, original]) => dialog[name] === original),
    windows: () => BrowserWindow.getAllWindows().length,
    reload: () =>
      new Promise((resolve) => {
        window.webContents.once('did-finish-load', () => resolve(true));
        window.webContents.reload();
      }),
  });
});
