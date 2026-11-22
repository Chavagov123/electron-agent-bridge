// Stand-in for @eab/electron/register and inject.cjs: wrap ipcMain registration as early as possible.
'use strict';
if (process.type === 'browser' && !globalThis[Symbol.for('eab.spike.installed')]) {
  globalThis[Symbol.for('eab.spike.installed')] = true;
  globalThis.__eabWrapped = 0;
  const install = (electron) => {
    const { ipcMain } = electron;
    const originalHandle = ipcMain.handle.bind(ipcMain);
    const originalOn = ipcMain.on.bind(ipcMain);
    ipcMain.handle = (channel, fn) => { globalThis.__eabWrapped += 1; return originalHandle(channel, fn); };
    ipcMain.on = (channel, fn) => { globalThis.__eabWrapped += 1; return originalOn(channel, fn); };
  };
  try {
    install(require('electron'));
    globalThis.__eabInstall = 'direct';
  } catch (error) {
    globalThis.__eabInstall = `direct-failed: ${error.message}`;
  }
  // Scrub launch-only env so child processes do not inherit the preload.
  if (process.env.NODE_OPTIONS && process.env.NODE_OPTIONS.includes('eab-register')) {
    process.env.NODE_OPTIONS = process.env.NODE_OPTIONS.replace(/--require\s+\S*eab-register\.cjs\S*/, '').trim();
    globalThis.__eabScrubbed = process.env.NODE_OPTIONS;
  }
}
