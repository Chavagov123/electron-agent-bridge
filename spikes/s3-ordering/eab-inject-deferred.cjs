// Launch-mode inject: electron is not resolvable at --require time, so install at the first moment it is.
'use strict';
if (process.type === 'browser' && !globalThis[Symbol.for('eab.spike.installed')]) {
  globalThis[Symbol.for('eab.spike.installed')] = true;
  globalThis.__eabWrapped = 0;
  globalThis.__eabTriggers = [];
  const Module = require('node:module');
  let installed = false;
  const tryInstall = (trigger) => {
    if (installed) return true;
    let electron;
    try { electron = originalLoad.call(Module, 'electron', null, false); } catch { globalThis.__eabTriggers.push(`${trigger}:not-yet`); return false; }
    if (!electron || !electron.ipcMain) { globalThis.__eabTriggers.push(`${trigger}:no-ipcMain`); return false; }
    installed = true;
    globalThis.__eabInstall = trigger;
    const { ipcMain } = electron;
    const originalHandle = ipcMain.handle.bind(ipcMain);
    const originalOn = ipcMain.on.bind(ipcMain);
    ipcMain.handle = (channel, fn) => { globalThis.__eabWrapped += 1; (globalThis.__eabChannels ||= []).push(channel); return originalHandle(channel, fn); };
    ipcMain.on = (channel, fn) => { globalThis.__eabWrapped += 1; (globalThis.__eabChannels ||= []).push(channel); return originalOn(channel, fn); };
    Module._load = originalLoad;   // unhook once done
    return true;
  };
  const originalLoad = Module._load;
  Module._load = function eabLoad(request, ...rest) {
    if (!installed) tryInstall(`Module._load(${String(request).split(/[\/]/).pop()})`);
    return originalLoad.call(this, request, ...rest);
  };
  tryInstall('immediate');
  process.nextTick(() => tryInstall('nextTick'));
  queueMicrotask(() => tryInstall('microtask'));
  setImmediate(() => tryInstall('setImmediate'));
  if (process.env.NODE_OPTIONS) process.env.NODE_OPTIONS = process.env.NODE_OPTIONS.replace(/--require\s+"?[^"\s]*eab-inject-deferred\.cjs"?/, '').trim();
  globalThis.__eabScrubbed = process.env.NODE_OPTIONS ?? '';
}
