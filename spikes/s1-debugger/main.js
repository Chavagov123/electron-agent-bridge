'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const out = (o) => process.stdout.write(`SPIKE ${JSON.stringify(o)}\n`);
const [ci, sb, ni] = (process.env.SPIKE_WEBPREFS || 'ci1-sb1-ni0').match(/\d/g).map(Number);
const agentSrc = fs.readFileSync(path.join(__dirname, 'agent-isolated.js'), 'utf8');
const hookSrc = fs.readFileSync(path.join(__dirname, 'hook-main.js'), 'utf8');
const t0 = Date.now();
const commandLog = [];
const contexts = [];
let hellos = 0;
let loadStartedAt = null;

function finish(extra) {
  out({ webPrefs: { contextIsolation: !!ci, sandbox: !!sb, nodeIntegration: !!ni }, commandLog, contexts, ...extra });
  process.stdout.write('SPIKE_DONE\n');
}

app.on('web-contents-created', (_event, wc) => {
  const dbg = wc.debugger;
  try { dbg.attach('1.3'); } catch (error) { out({ attachError: error.message }); return; }
  // Fire-and-forget, in order. Record when each resolves relative to first navigation.
  const post = (method, params) => {
    const sentAt = Date.now() - t0;
    dbg.sendCommand(method, params).then(
      () => commandLog.push({ method, sentAt, resolvedAt: Date.now() - t0, beforeLoad: loadStartedAt === null }),
      (error) => commandLog.push({ method, sentAt, error: error.message })
    );
  };
  dbg.on('message', async (_e, method, params) => {
    if (method === 'Runtime.executionContextCreated') {
      contexts.push({ name: params.context.name, type: params.context.auxData && params.context.auxData.type });
    }
    if (method === 'Runtime.bindingCalled' && params.name === '__eabPush') {
      const msg = JSON.parse(params.payload);
      if (msg.type !== 'hello' || !msg.isTop) return;
      hellos += 1;
      out({ hello: hellos, ...msg, at: Date.now() - t0 });
      if (hellos === 1) { wc.reload(); return; }
      const state = await dbg.sendCommand('Runtime.evaluate', {
        expression: 'JSON.stringify({stores: globalThis[Symbol.for("eab.state")]?.stores.length, state: globalThis[Symbol.for("eab.state")]?.stores[0]?.getState()})',
        returnByValue: true
      });
      finish({ ok: true, mainWorldState: state.result.value });
    }
  });
  post('Runtime.enable');
  post('Page.enable');
  post('Runtime.addBinding', { name: '__eabPush', executionContextName: '__eab' });
  post('Page.addScriptToEvaluateOnNewDocument', { source: hookSrc, runImmediately: true });
  post('Page.addScriptToEvaluateOnNewDocument', { source: agentSrc, worldName: '__eab', runImmediately: true });
});

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: !!ci, sandbox: !!sb, nodeIntegration: !!ni } });
  loadStartedAt = Date.now() - t0;
  win.loadFile(path.join(__dirname, 'index.html'));
  setTimeout(() => finish({ ok: false, reason: 'no second hello within 10s', hellos }), 10000);
});
