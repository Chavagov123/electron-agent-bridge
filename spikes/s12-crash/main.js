'use strict';
// SPIKE_BRIDGE=1 installs the observer; SPIKE_CASE = throw | reject; SPIKE_APP_HANDLER=1 adds an app handler.
const { app, dialog } = require('electron');
const out = (o) => process.stdout.write(`SPIKE ${JSON.stringify(o)}\n`);
const observed = [];
// Make the default error dialog observable instead of blocking the run.
const originalShowErrorBox = dialog.showErrorBox;
dialog.showErrorBox = (title, content) => {
  out({ dialog: true, title, first: String(content).split('\n')[0] });
  process.stdout.write('SPIKE_DONE\n');
};
if (process.env.SPIKE_BRIDGE === '1') {
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    observed.push({ origin, message: error && error.message });
    out({ monitor: true, origin, message: error && error.message });
  });
}
if (process.env.SPIKE_BRIDGE === '1') {
  process.on('warning', (w) => { observed.push({ warning: w.name, message: String(w.message).slice(0, 80) }); });
}
if (process.env.SPIKE_APP_HANDLER === '1') {
  process.on('uncaughtException', (error) => { out({ appHandler: 'uncaughtException', message: error.message }); process.stdout.write('SPIKE_DONE\n'); });
}
app.whenReady().then(() => {
  out({ listeners: { uncaughtException: process.listenerCount('uncaughtException'), unhandledRejection: process.listenerCount('unhandledRejection') }, unhandledRejectionsMode: process.execArgv.join(' ') || 'default' });
  setTimeout(() => {
    if (process.env.SPIKE_CASE === 'reject') Promise.reject(new Error('boom-reject'));
    else throw new Error('boom-throw');
  }, 50);
  setTimeout(() => { out({ survived: true, observed }); process.stdout.write('SPIKE_DONE\n'); }, 1500);
});
void originalShowErrorBox;
