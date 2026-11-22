'use strict';
// First import: the bridge must hook in before the app creates windows (off unless EAB_ENABLE=1).
// In Launch-mode tests the app stays unmodified: the launcher injects the bridge instead.
if (process.env.EAB_FIXTURE_MODE !== 'launch') require('@electron-agent-bridge/electron/register');
const path = require('node:path');
const { createFixtureWindow, handleCommands, runFixture } = require('@eab-fixtures/fixture-kit');

runFixture(async () => {
  const window = await createFixtureWindow({
    file: path.join(__dirname, 'index.html'),
    name: 'app-host-debugger',
  });
  const { debugger: debuggerApi } = window.webContents;
  // What a real app might do: attach its own debugger, use it, and let go later.
  handleCommands({
    attach: async () => {
      debuggerApi.attach('1.3');
      const { result } = await debuggerApi.sendCommand('Runtime.evaluate', {
        expression: '6 * 7',
        returnByValue: true,
      });
      return result.value;
    },
    // The common defensive pattern: only attach when nobody is attached.
    'attach-if-free': async () => {
      if (debuggerApi.isAttached()) return 'already attached';
      debuggerApi.attach('1.3');
      const { result } = await debuggerApi.sendCommand('Runtime.evaluate', {
        expression: '6 * 7',
        returnByValue: true,
      });
      return result.value;
    },
    detach: () => {
      debuggerApi.detach();
      return debuggerApi.isAttached();
    },
  });
});
