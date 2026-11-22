// Plays the app's own webPreferences.preload.
const { ipcRenderer, contextBridge } = require('electron');
const sawEab = globalThis.__eabPreloadRan || 0;
const api = {
  ping: (n) => ipcRenderer.invoke('app:ping', n),
  evt: (n) => ipcRenderer.send('app:evt', n),
  done: () => ipcRenderer.send('app:done', { sawEab, isMainFrame: process.isMainFrame })
};
if (process.contextIsolated) contextBridge.exposeInMainWorld('api', api);
else window.api = api;
