// Our session-registered frame preload. Sandbox-safe: only require('electron').
const { ipcRenderer, contextBridge } = require('electron');
globalThis.__eabPreloadRan = (globalThis.__eabPreloadRan || 0) + 1;
const records = [];
const original = {};
for (const name of ['send', 'invoke', 'sendSync']) {
  original[name] = ipcRenderer[name];
  ipcRenderer[name] = function wrapped(channel, ...args) {
    if (channel === 'app:done') {
      original.send.call(ipcRenderer, '__eab:uplink', {
        href: location.href, isMainFrame: process.isMainFrame, records, exposed, exposeWrapError
      });
    } else records.push([name, channel, typeof args[0] === 'number' ? args[0] : null]);
    return original[name].call(this, channel, ...args);
  };
}
const exposed = [];
let exposeWrapError = null;
try {
  const originalExpose = contextBridge.exposeInMainWorld;
  contextBridge.exposeInMainWorld = function wrappedExpose(key, api) {
    exposed.push(key);
    return originalExpose.call(this, key, api);
  };
} catch (error) { exposeWrapError = error.message; }
// Unconditional presence report, so subframes without an app API still show up.
window.addEventListener('DOMContentLoaded', () => {
  original.send.call(ipcRenderer, '__eab:uplink', { href: location.href, isMainFrame: process.isMainFrame, records: [], exposed, exposeWrapError, hello: true });
});
