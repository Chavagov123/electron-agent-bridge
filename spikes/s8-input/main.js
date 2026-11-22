'use strict';
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const out = (o) => process.stdout.write(`SPIKE ${JSON.stringify(o)}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clicks = [];
const log = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/click') { clicks.push(Object.fromEntries(url.searchParams)); res.end('ok'); return; }
  const port = server.address().port;
  fs.readFile(path.join(__dirname, url.pathname.slice(1)), 'utf8', (err, body) => {
    if (err) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', 'text/html');
    res.end(body.replace('CROSS', `http://127.0.0.1:${port}`).replace('SAME', `http://localhost:${port}`));
  });
});
const click = async (dbg, x, y, sessionId) => {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await dbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 }, sessionId);
  }
};
app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const win = new BrowserWindow({ show: true, width: 500, height: 520, webPreferences: { webviewTag: true } });
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  const sessions = [];
  dbg.on('message', (_e, method, params) => {
    if (method === 'Target.attachedToTarget') sessions.push({ sessionId: params.sessionId, type: params.targetInfo.type, url: params.targetInfo.url });
  });
  let guest = null;
  win.webContents.on('did-attach-webview', (_e, wc) => { guest = wc; });
  await dbg.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await win.loadURL(`http://localhost:${port}/top.html`);
  await wait(2000);
  log.push({ sessions: sessions.map((s) => `${s.type}:${s.url.replace(/:\d+/, '')}`) });

  // 1. Top-level button via top session.
  await click(dbg, 80, 40);
  // 2. OOPIF button: top-level coordinates (iframe offset 20,100 + button 30,30 + half size).
  await click(dbg, 20 + 30 + 60, 100 + 30 + 20);
  // 3. OOPIF button: via the iframe's own session with frame-local coordinates.
  const oopif = sessions.find((s) => s.type === 'iframe');
  if (oopif) { try { await click(dbg, 30 + 60, 30 + 20, oopif.sessionId); log.push('oopif-session click sent'); } catch (e) { log.push(`oopif-session click FAIL ${e.message}`); } }
  // 4. Webview via top-level coordinates.
  await click(dbg, 20 + 30 + 60, 300 + 30 + 20);
  // 5. Webview via its own guest webContents debugger, guest-local coordinates.
  if (guest) {
    try { guest.debugger.attach('1.3'); await click(guest.debugger, 30 + 60, 30 + 20); log.push('guest debugger click sent'); }
    catch (e) { log.push(`guest debugger FAIL ${e.message}`); }
  } else log.push('no guest webContents');
  await wait(1000);
  if (oopif) {
    try {
      const r = await dbg.sendCommand('Runtime.evaluate', { expression: 'JSON.stringify({href: location.href, hasBtn: !!document.getElementById("btn"), clicks: window.__clicks})', returnByValue: true }, oopif.sessionId);
      log.push({ oopifState: r.result.value });
    } catch (e) { log.push(`oopif eval FAIL ${e.message}`); }
  }
  out({ log, clicks });
  process.stdout.write('SPIKE_DONE\n');
});
