'use strict';
// First: the bridge (off unless EAB_ENABLE=1). Values of `settings:*` are recorded (redacted) to test
// the opt-in; every other channel is shape-only. In Launch-mode tests the launcher injects the bridge.
if (process.env.EAB_FIXTURE_MODE !== 'launch') {
  require('@eab/electron').enableAgentBridge({ ipc: { values: ['settings:*'] } });
}
const path = require('node:path');
const { BrowserWindow, MessageChannelMain, ipcMain, utilityProcess } = require('electron');
const { createFixtureWindow, handleCommands, runFixture } = require('@eab-fixtures/fixture-kit');

// What main observed, compared with the bridge off and on (transparency).
const digest = { logLines: [], logSecond: 0, once: 0, removed: 0, thisIsIpcMain: [], replaced: '' };

// Early registrations: before the app is ready, as most apps do.
ipcMain.handle('math:add', function add(_event, a, b) {
  digest.thisIsIpcMain.push(this === ipcMain || this === undefined);
  return a + b;
});
ipcMain.handle('math:slow', async (_event, ms) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { done: true, ms };
});
ipcMain.handle('math:fail', () => {
  throw new Error('boom');
});
ipcMain.handle('math:reject', async () => {
  throw new Error('nope');
});
ipcMain.on('log:write', (_event, line) => digest.logLines.push(line));
ipcMain.on('log:write', () => (digest.logSecond += 1));
ipcMain.on('sync:get', (event, key) => {
  event.returnValue = { key, value: 42 };
});
// Answered later, as an app does after its dialog window closes: the page is blocked meanwhile.
let answerDialog;
ipcMain.on('sync:dialog', (event) => {
  const dialog = new BrowserWindow({ show: false, width: 300, height: 150 });
  void dialog.loadURL('data:text/html,<title>Confirm</title><button>OK</button>');
  answerDialog = (value) => {
    dialog.destroy();
    event.returnValue = value;
  };
});
ipcMain.once('once:ping', () => (digest.once += 1));
ipcMain.handleOnce('once:handle', () => 'only once');
const removed = () => (digest.removed += 1);
ipcMain.on('rm:listener', removed);
ipcMain.removeListener('rm:listener', removed);
ipcMain.handle('rm:handler', () => 'first');
ipcMain.removeHandler('rm:handler');
ipcMain.handle('rm:handler', () => 'second');
ipcMain.handle('settings:save', (_event, settings) => Object.keys(settings).sort());
ipcMain.on('burst:item', () => undefined);

/** Main ↔ utility process messages, then a MessagePort between them; returns what main received. */
function processes() {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(__dirname, 'utility.cjs'), [], { serviceName: 'echo' });
    const received = [];
    const timer = setTimeout(() => reject(new Error('utility process did not answer')), 10_000);
    child.on('message', (message) => {
      received.push(message);
      if (received.length === 1) {
        const { port1, port2 } = new MessageChannelMain();
        port1.on('message', (event) => {
          received.push(event.data);
          clearTimeout(timer);
          port1.close();
          child.kill();
          resolve(received);
        });
        port1.start();
        child.postMessage({ job: 2 }, [port2]);
        port1.postMessage({ ping: 1 });
      }
    });
    child.on('spawn', () => child.postMessage({ job: 1 }));
  });
}

runFixture(async () => {
  const window = await createFixtureWindow({
    file: path.join(__dirname, 'index.html'),
    name: 'app-ipc',
    preload: path.join(__dirname, 'preload.cjs'),
  });
  // Scoped to this page only.
  window.webContents.ipc.handle('page:only', () => 'scoped');
  const page = (script) => window.webContents.executeJavaScript(script);
  handleCommands({
    scenario: () => page('window.scenario()'),
    'main-digest': () => digest,
    'push-ticks': () => {
      for (let tick = 1; tick <= 3; tick++) window.webContents.send('push:tick', tick);
      return page('new Promise((resolve) => setTimeout(() => resolve(window.ticks), 200))');
    },
    // Registered late, then called from the page shortly after.
    'late-handler': () => {
      ipcMain.handle('late:handler', () => 'late');
      setTimeout(() => page('window.api.late()'), 300);
      return true;
    },
    burst: () => page('window.api.burst(300)'),
    flood: () => page('window.api.burst(5000)'),
    processes,
    // The page asks and is blocked until `unblock` answers.
    block: () => page('setTimeout(() => (window.dialogAnswer = window.api.syncDialog()), 0); true'),
    unblock: () => {
      answerDialog?.(7);
      return page('window.dialogAnswer');
    },
  });
});
