'use strict';
// The app's own preload: a typical contextBridge API over ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  add: (a, b) => ipcRenderer.invoke('math:add', a, b),
  slow: (ms) => ipcRenderer.invoke('math:slow', ms),
  fail: () => ipcRenderer.invoke('math:fail'),
  reject: () => ipcRenderer.invoke('math:reject'),
  missing: () => ipcRenderer.invoke('no:handler'),
  log: (line) => ipcRenderer.send('log:write', line),
  syncGet: (key) => ipcRenderer.sendSync('sync:get', key),
  syncDialog: () => ipcRenderer.sendSync('sync:dialog'),
  oncePing: () => ipcRenderer.send('once:ping'),
  onceHandle: () => ipcRenderer.invoke('once:handle'),
  removedListener: () => ipcRenderer.send('rm:listener'),
  replacedHandler: () => ipcRenderer.invoke('rm:handler'),
  pageOnly: () => ipcRenderer.invoke('page:only'),
  late: () => ipcRenderer.invoke('late:handler'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  burst: (count) => {
    for (let index = 0; index < count; index++) ipcRenderer.send('burst:item', index);
    return count;
  },
  onTick: (listener) => ipcRenderer.on('push:tick', (_event, tick) => listener(tick)),
});
