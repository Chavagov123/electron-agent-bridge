// The app's own main entry, as written in an electron-vite / webpack project: the bridge is its
// first import, then the app. The e2e spec bundles this file.
import '@electron-agent-bridge/electron/register';

import path from 'node:path';

import { createFixtureWindow, handleCommands, runFixture } from '@eab-fixtures/fixture-kit';
import { ipcMain } from 'electron';

ipcMain.handle('bundled:ping', (_event, value) => `pong ${value}`);

runFixture(async () => {
  const window = await createFixtureWindow({
    // The bundle runs from dist/: the page and preload stay next to the fixture.
    file: path.join(__dirname, '..', 'index.html'),
    name: 'app-bundled',
    preload: path.join(__dirname, '..', 'preload.cjs'),
  });
  handleCommands({ ping: () => window.webContents.executeJavaScript('window.api.ping("from page")') });
});
