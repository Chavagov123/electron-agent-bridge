// Launch fallback: --inspect-brk=0, pause before the first *user* script executes
// (beforeScriptExecution instrumentation breakpoint), inject on that call frame, then resume.
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

const version = process.argv[2] || '45';
const main = process.argv[3] || 'main-cjs-plain.cjs';
const inject = path.resolve(__dirname, 'eab-inject-deferred.cjs');
const child = spawn(require(`electron-${version}`), ['--inspect-brk=0', path.resolve(__dirname, main)], {
  env: { ...process.env, SPIKE_VARIANT: `${main}+inspector` }, stdio: ['ignore', 'pipe', 'pipe']
});
const t0 = Date.now();
let stdout = '';
let connected = false;
const pausedUrls = [];
const timer = setTimeout(() => { console.log(version, main, 'TIMEOUT', pausedUrls.slice(0, 8)); child.kill(); }, 25000);
child.stdout.on('data', (d) => {
  stdout += d;
  if (stdout.includes('SPIKE_DONE')) {
    const line = stdout.split('\n').find((l) => l.startsWith('SPIKE '));
    console.log(version, main, line ? line.slice(6) : '(no result)', `${Date.now() - t0}ms`, 'pauses:', pausedUrls.length, JSON.stringify([...new Set(pausedUrls)].filter(u => !String(u).startsWith('node:')).slice(0, 12)));
    clearTimeout(timer);
    child.kill();
  }
});
const isUserScript = (url) => url && !url.startsWith('node:') && !url.includes('electron/js2c') && (!url.includes('app.asar') || url.includes('default_app.asar/main.js'))
  && (!url.includes(`electron-${version}`) || url.includes('default_app.asar/main.js')) && /^(file:|[A-Za-z]:\\|\/)/.test(url);

child.stderr.on('data', (d) => {
  const match = /ws:\/\/[^\s]+/.exec(d.toString());
  if (!match || connected) return;
  connected = true;
  const ws = new WebSocket(match[0]);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((resolve) => {
    id += 1; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params }));
  });
  let done = false;
  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method !== 'Debugger.paused') return;
    const frame = msg.params.callFrames[0];
    const url = (msg.params.data && msg.params.data.url) || (frame && frame.url);
    pausedUrls.push(url);
    if (done || !isUserScript(url)) { await send('Debugger.resume'); return; }
    done = true;
    const expr = `process.getBuiltinModule('node:module').createRequire(${JSON.stringify(inject)})(${JSON.stringify(inject)}); 'injected'`;
    const result = frame ? await send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: expr }) : await send('Runtime.evaluate', { expression: expr });
    console.log('injected before', url, frame ? 'on call frame' : 'global');
    if (result.result && result.result.exceptionDetails) console.log('inject exception at', url, result.result.exceptionDetails.exception.description.slice(0, 200));
    await send('Debugger.removeInstrumentationBreakpoint', { breakpointId: instrumentationId });
    await send('Debugger.resume');
    await send('Debugger.disable');
    ws.close();
  };
  let instrumentationId;
  ws.onopen = async () => {
    await send('Debugger.enable');
    const bp = await send('Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptExecution' });
    instrumentationId = bp.result.breakpointId;
    await send('Runtime.runIfWaitingForDebugger');
  };
});
