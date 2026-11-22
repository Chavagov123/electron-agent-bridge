'use strict';
// First import: the bridge must hook in before the app creates windows (off unless EAB_ENABLE=1).
// In Launch-mode tests the app stays unmodified: the launcher injects the bridge instead.
if (process.env.EAB_FIXTURE_MODE !== 'launch') require('@electron-agent-bridge/electron/register');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { createFixtureWindow, handleCommands, runFixture } = require('@eab-fixtures/fixture-kit');

// Main-process event-loop delay (NFR4): how long the app's own work waits while it is automated.
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

runFixture(async () => {
  const window = await createFixtureWindow({ file: path.join(__dirname, 'index.html'), name: 'app-heavy' });
  const page = (script) => window.webContents.executeJavaScript(script);
  handleCommands({
    'count-elements': () => page('document.querySelectorAll("*").length'),
    // Small, realistic changes: a few cells updated, one row added.
    'mutate-10': () => page('window.mutate(10)'),
    'mutate-100': () => page('window.mutate(100)'),
    'loop-delay-reset': () => {
      loopDelay.reset();
      return true;
    },
    // p99 and max in ms (the histogram counts nanoseconds; the 10 ms sampling interval is subtracted).
    'loop-delay': () => ({
      p99: Math.max(0, loopDelay.percentile(99) / 1e6 - 10),
      max: Math.max(0, loopDelay.max / 1e6 - 10),
    }),
  });
});
