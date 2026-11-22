'use strict';
const { app, BrowserWindow } = require('electron');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');
const out = (o) => process.stdout.write(`SPIKE ${JSON.stringify(o)}\n`);
const agent = fs.readFileSync(path.join(__dirname, 'agent.js'), 'utf8');
const measureEld = async (fn) => {
  const h = monitorEventLoopDelay({ resolution: 1 }); h.enable();
  await fn(); h.disable();
  return { p50ms: +(h.percentile(50) / 1e6).toFixed(2), p99ms: +(h.percentile(99) / 1e6).toFixed(2), maxms: +(h.max / 1e6).toFixed(2) };
};
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1280, height: 800 });
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  let isolatedCtx = null; let pushes = 0; let resolveResult;
  const resultP = new Promise((r) => { resolveResult = r; });
  dbg.on('message', (_e, method, params) => {
    if (method === 'Runtime.executionContextCreated' && params.context.name === '__eab') isolatedCtx = params.context.id;
    if (method === 'Runtime.bindingCalled') {
      pushes += 1;
      const msg = JSON.parse(params.payload);
      if (msg.type === 'result') resolveResult(msg.result);
    }
  });
  dbg.sendCommand('Runtime.enable');
  dbg.sendCommand('Runtime.addBinding', { name: '__eabPush', executionContextName: '__eab' });
  dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: agent, worldName: '__eab', runImmediately: true });
  await win.loadFile(path.join(__dirname, 'index.html'));
  await new Promise((r) => setTimeout(r, 300));
  const evalIso = (expression) => dbg.sendCommand('Runtime.evaluate', { expression, contextId: isolatedCtx, awaitPromise: true });
  await evalIso('__eabRun()');
  const page = await resultP;
  const idle = await measureEld(() => new Promise((r) => setTimeout(r, 3000)));
  pushes = 0;
  const storm = await measureEld(() => evalIso('__eabStorm(3000)'));
  out({ page, mainEventLoopDelay: { idle, storm, addedP99ms: +(storm.p99ms - idle.p99ms).toFixed(2), pushesDuringStorm: pushes } });
  process.stdout.write('SPIKE_DONE\n');
});
