import { ipcMain } from 'electron';
for (let i = 0; i < 3; i += 1) ipcMain.handle(`esm:h${i}`, () => i);
ipcMain.on('esm:on', () => {});
export default 4;
