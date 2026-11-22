'use strict';
/**
 * Deterministic fixture windows for e2e tests.
 *
 * - Window size 1280x800, device scale factor 1, animations/transitions disabled.
 * - webPreferences come from EAB_FIXTURE_WEBPREFS, e.g. "ci1-sb1-ni0"
 *   (contextIsolation, sandbox, nodeIntegration). Invalid combos are rejected.
 * - When the first window has loaded, prints one line: `EAB_FIXTURE_READY {json}` on stdout.
 *   The e2e harness waits for that line instead of sleeping.
 */
const net = require('node:net');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { app, BrowserWindow, screen } = require('electron');

const NO_MOTION_CSS =
  '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';

app.commandLine.appendSwitch('force-device-scale-factor', '1');

/**
 * `FIXTURE_BACKGROUND=1` (set by the e2e harness for `EAB_E2E_BACKGROUND=1`): windows are shown off the desktop without taking focus, so a test run
 * does not pull the screen away from other work; and pages behind other windows are not throttled or
 * left unpainted, so timing, actionability and screenshots behave as in the foreground.
 */
const BACKGROUND = process.env.FIXTURE_BACKGROUND === '1';
if (BACKGROUND) {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}

/**
 * A position right of every monitor: Windows puts a newly shown window on top even without focus,
 * so a background window has to be where no one is looking.
 */
function offDesktop() {
  const right = Math.max(...screen.getAllDisplays().map(({ bounds }) => bounds.x + bounds.width));
  return { x: right + 200, y: 0 };
}

function parseWebPrefs(spec = process.env.EAB_FIXTURE_WEBPREFS || 'ci1-sb1-ni0') {
  const match = /^ci([01])-sb([01])-ni([01])$/.exec(spec);
  if (!match) throw new Error(`EAB_FIXTURE_WEBPREFS must look like ci1-sb1-ni0, got "${spec}"`);
  const [contextIsolation, sandbox, nodeIntegration] = match.slice(1).map((flag) => flag === '1');
  if (nodeIntegration && sandbox) throw new Error('nodeIntegration requires sandbox off');
  return { contextIsolation, sandbox, nodeIntegration };
}

/** Print the ready line for fixture `name`. Called by createFixtureWindow unless it was deferred. */
function announceReady(name) {
  const { contextIsolation, sandbox, nodeIntegration } = parseWebPrefs();
  const info = {
    fixture: name,
    pid: process.pid,
    electron: process.versions.electron,
    webPreferences: { contextIsolation, sandbox, nodeIntegration },
  };
  process.stdout.write(`EAB_FIXTURE_READY ${JSON.stringify(info)}\n`);
}

/**
 * Let a spec drive the fixture deterministically. The harness listens on a local socket and passes
 * its path in `EAB_FIXTURE_CONTROL` (stdin is unreliable for Electron's main process on Windows).
 * Each line received is a command name; each reply is one JSON line `{"command","ok","result"|"error"}`.
 * @param {Record<string, () => unknown>} handlers
 */
function handleCommands(handlers) {
  const path = process.env.EAB_FIXTURE_CONTROL;
  if (!path) return;
  // Traced on stdout, so a harness timeout shows how far a command got.
  const trace = (event) => process.stdout.write(`EAB_FIXTURE_CONTROL_${event}\n`);
  // First line: who this is, so the harness talks to the process it launched.
  const socket = net.connect(path, () => {
    socket.write(`${JSON.stringify({ hello: process.pid })}\n`);
    trace('CONNECTED');
  });
  socket.setEncoding('utf8');
  socket.on('error', (error) => trace(`ERROR ${error.message}`));
  socket.on('close', () => trace('CLOSED'));
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      trace(`COMMAND ${line.trim()}`);
      void runCommand(handlers, line.trim(), socket);
    }
  });
}

// Main-process event-loop delay (NFR4), in every fixture: how long the app's own work waits while it is
// automated. p99 and max in ms (the histogram counts nanoseconds; the 10 ms sampling interval is subtracted).
let loopDelay;
const BUILT_IN = {
  'loop-delay-reset': () => {
    loopDelay ??= monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
    loopDelay.reset();
    return true;
  },
  'loop-delay': () =>
    loopDelay
      ? { p99: Math.max(0, loopDelay.percentile(99) / 1e6 - 10), max: Math.max(0, loopDelay.max / 1e6 - 10) }
      : null,
};

async function runCommand(handlers, command, socket) {
  if (command === '') return;
  const reply = (body) => {
    socket.write(`${JSON.stringify({ command, ...body })}\n`);
    process.stdout.write(`EAB_FIXTURE_CONTROL_REPLIED ${command}\n`);
  };
  const handler = handlers[command] ?? BUILT_IN[command];
  if (!handler) return reply({ ok: false, error: `unknown command ${command}` });
  try {
    reply({ ok: true, result: (await handler()) ?? null });
  } catch (error) {
    reply({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}

/**
 * Create the fixture's main window and load `file`.
 * With `deferReady`, the caller calls `announceReady(name)` itself once its other windows exist.
 * @param {{ file: string, name: string, preload?: string, extraWebPreferences?: object, deferReady?: boolean }} options
 */
async function createFixtureWindow({
  file,
  url,
  name,
  preload,
  extraWebPreferences = {},
  deferReady = false,
}) {
  const webPreferences = {
    ...parseWebPrefs(),
    ...(preload ? { preload } : {}),
    ...(BACKGROUND ? { backgroundThrottling: false } : {}),
    ...extraWebPreferences,
  };
  const hidden = process.env.EAB_FIXTURE_HIDE === '1';
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: !hidden && !BACKGROUND,
    // A real, shown window, but past the right edge of every monitor and out of the taskbar.
    ...(BACKGROUND ? { ...offDesktop(), skipTaskbar: true, paintWhenInitiallyHidden: true } : {}),
    title: name,
    webPreferences,
  });
  if (BACKGROUND && !hidden) window.showInactive();
  window.webContents.on('did-finish-load', () => {
    window.webContents.insertCSS(NO_MOTION_CSS).catch(() => undefined);
  });
  if (url) await window.loadURL(url);
  else await window.loadFile(file);
  if (!deferReady) announceReady(name);
  return window;
}

/** Standard lifecycle: quit when all windows close, on every platform, so tests never leave processes behind. */
function runFixture(start) {
  app.on('window-all-closed', () => app.quit());
  // An uncaught exception makes Electron show a blocking error box (no output): say what it was.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    process.stderr.write(
      `EAB_FIXTURE_UNCAUGHT ${origin}: ${error && error.stack ? error.stack : String(error)}\n`,
    );
  });
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      process.stderr.write(`fixture failed to start: ${error && error.stack}\n`);
      app.exit(1);
    });
}

module.exports = { announceReady, createFixtureWindow, handleCommands, parseWebPrefs, runFixture };
