'use strict';
const { app, BrowserWindow, ipcMain, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const out = (o) => process.stdout.write(`SPIKE ${JSON.stringify(o)}\n`);
const [ci, sb] = (process.env.SPIKE_WEBPREFS || 'ci1-sb1').match(/\d/g).map(Number);
const arrivals = { evt: [], ping: [] };
const uplinks = [];
const dones = [];

const server = http.createServer((req, res) => {
  const file = path.join(__dirname, req.url === '/' ? 'index.html' : req.url.slice(1));
  fs.readFile(file, 'utf8', (err, body) => {
    if (err) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', 'text/html');
    res.end(body.replace('CROSS_ORIGIN', `http://127.0.0.1:${server.address().port}`));
  });
});

ipcMain.on('app:evt', (_e, n) => arrivals.evt.push(n));
ipcMain.handle('app:ping', (_e, n) => { arrivals.ping.push(n); return n; });
ipcMain.on('app:done', (e, info) => dones.push({ ...info, type: e.sender.getType(), url: e.senderFrame && e.senderFrame.url }));
ipcMain.on('__eab:uplink', (e, payload) => uplinks.push({
  type: e.sender.getType(), href: payload.href, isMainFrame: payload.isMainFrame,
  recordCount: payload.records.length, hello: !!payload.hello, exposed: payload.exposed, exposeWrapError: payload.exposeWrapError,
  rendererOrder: payload.records.filter((r) => r[1] !== 'app:done').slice(0, 6)
}));

const inOrder = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] < x);

app.whenReady().then(async () => {
  let registerApi = 'registerPreloadScript';
  if (typeof session.defaultSession.registerPreloadScript === 'function') {
    session.defaultSession.registerPreloadScript({ type: 'frame', id: 'eab', filePath: path.join(__dirname, 'eab-preload.js') });
  } else {
    registerApi = 'setPreloads';
    session.defaultSession.setPreloads([path.join(__dirname, 'eab-preload.js')]);
  }
  await new Promise((r) => server.listen(0, 'localhost', r));
  const win = new BrowserWindow({ show: false, webPreferences: {
    contextIsolation: !!ci, sandbox: !!sb, webviewTag: true, preload: path.join(__dirname, 'app-preload.js') } });
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (_ev, webPreferences) => { webPreferences.preload = path.join(__dirname, 'app-preload.js'); });
  });
  win.webContents.on('will-attach-webview', (_ev, webPreferences) => { webPreferences.preload = path.join(__dirname, 'app-preload.js'); });
  win.loadURL(`http://localhost:${server.address().port}/`);
  setTimeout(() => {
    out({ webPrefs: { contextIsolation: !!ci, sandbox: !!sb }, registerApi,
      evtCount: arrivals.evt.length, pingCount: arrivals.ping.length,
      evtInOrder: inOrder(arrivals.evt), pingInOrder: inOrder(arrivals.ping),
      dones, uplinks });
    process.stdout.write('SPIKE_DONE\n');
  }, 5000);
});
