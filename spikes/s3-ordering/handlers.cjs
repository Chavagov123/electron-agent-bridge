const { ipcMain } = require('electron');
for (let i = 0; i < 3; i += 1) ipcMain.handle(`cjs:h${i}`, () => i);
ipcMain.on('cjs:on', () => {});
module.exports = 4;
