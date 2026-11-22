const { ipcRenderer } = require('electron');
window.addEventListener('DOMContentLoaded', async () => {
  ipcRenderer.send('ch:send', { a: 1 });
  await ipcRenderer.invoke('ch:invoke', 42);
  ipcRenderer.sendSync('ch:sync', 'x');
  ipcRenderer.send('ch:unhandled', 1);   // no listener in main
  ipcRenderer.send('done');
});
