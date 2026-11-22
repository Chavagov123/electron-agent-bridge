'use strict';
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const out = (o) => process.stdout.write(`SPIKE ${JSON.stringify(o)}\n`);
const seen = {};
const note = (source) => (...args) => {
  // Find the channel argument (first string) and the sender id if present.
  const channel = args.find((a) => typeof a === 'string');
  const event = args[0];
  (seen[source] ||= []).push({ channel, senderId: event && event.sender && event.sender.id, argc: args.length });
};
ipcMain.on('ch:send', () => {});
ipcMain.handle('ch:invoke', (_e, n) => n);
ipcMain.on('ch:sync', (e) => { e.returnValue = 'ok'; });
app.whenReady().then(() => {
  const ses = session.defaultSession;
  for (const ev of ['-ipc-message', '-ipc-invoke', '-ipc-message-sync', '-ipc-ports']) ses.on(ev, note(`session:${ev}`));
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  const wc = win.webContents;
  for (const ev of ['ipc-message', 'ipc-message-sync', '-ipc-message', '-ipc-invoke', '-ipc-message-sync']) wc.on(ev, note(`wc:${ev}`));
  ipcMain.on('done', () => setTimeout(() => {
    const summary = Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.map((x) => x.channel)]));
    out({ summary, sample: Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v[0]])) });
    process.stdout.write('SPIKE_DONE\n');
  }, 300));
  win.loadURL('data:text/html,<p>s4</p>');
});
