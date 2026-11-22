'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', { ping: (value) => ipcRenderer.invoke('bundled:ping', value) });
