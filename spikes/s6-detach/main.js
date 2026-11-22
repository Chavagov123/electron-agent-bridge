'use strict';
const { app, BrowserWindow } = require('electron');
const out = (o) => process.stdout.write(`SPIKE ${JSON.stringify(o)}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const probe = async (dbg, label) => {
  try { const r = await dbg.sendCommand('Runtime.evaluate', { expression: '1+1', returnByValue: true }); log.push(`${label}: ok ${r.result.value}`); }
  catch (e) { log.push(`${label}: FAIL ${e.message}`); }
};
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 400, height: 300 });
  await win.loadURL('data:text/html,<p>s6</p>');
  const wc = win.webContents;
  const dbg = wc.debugger;
  let ours = false;
  dbg.on('detach', (_e, reason) => { log.push(`detach event: ${reason}`); ours = false; });
  dbg.attach('1.3'); ours = true;
  await probe(dbg, 'ours attached');

  // Part A: DevTools open/close.
  wc.openDevTools({ mode: 'detach' });
  await new Promise((r) => wc.once('devtools-opened', r));
  await wait(1000);
  log.push(`after devtools open: isAttached=${dbg.isAttached()} ours=${ours}`);
  await probe(dbg, 'with devtools open');
  wc.closeDevTools();
  await wait(800);
  log.push(`after devtools close: isAttached=${dbg.isAttached()}`);
  if (!dbg.isAttached()) { try { dbg.attach('1.3'); log.push('re-attached'); } catch (e) { log.push(`re-attach failed ${e.message}`); } }
  await probe(dbg, 'after devtools close');

  // Part B: host app attaches while we are attached.
  try { dbg.attach('1.3'); log.push('host attach (no guard): succeeded'); }
  catch (e) { log.push(`host attach (no guard): THROWS ${e.message}`); }
  // Guard: wrap attach so host attach makes us yield first.
  const originalAttach = dbg.attach.bind(dbg);
  dbg.attach = (...args) => { if (dbg.isAttached()) { dbg.detach(); log.push('guard: we yielded'); } return originalAttach(...args); };
  try { dbg.attach('1.3'); log.push('host attach (guarded): succeeded'); } catch (e) { log.push(`host attach (guarded): THROWS ${e.message}`); }
  await probe(dbg, 'host using debugger');
  out({ log });
  process.stdout.write('SPIKE_DONE\n');
});
