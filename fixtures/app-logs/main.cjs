'use strict';
// First: the bridge (off unless EAB_ENABLE=1). In Launch-mode tests the launcher injects it instead.
if (process.env.EAB_FIXTURE_MODE !== 'launch') require('@eab/electron').enableAgentBridge();
const http = require('node:http');
const path = require('node:path');
const { BrowserWindow, dialog, net } = require('electron');
const { addLogSource, loggerSource } = require('@eab/electron');
const { createFixtureWindow, handleCommands, runFixture } = require('@eab-fixtures/fixture-kit');

// What the app observed, compared with the bridge off and on (transparency).
const digest = { handler: [], errorBoxes: [], warnings: [] };
// Electron's default for an uncaught main exception is a blocking error box: record it instead.
dialog.showErrorBox = (title, content) => {
  digest.errorBoxes.push(`${title} | ${String(content).split('\n').slice(0, 2).join(' ')}`);
};
if (process.env.FIXTURE_APP_HANDLER === '1') {
  process.on('uncaughtException', (error) => digest.handler.push(error.message));
}
process.on('warning', (warning) => digest.warnings.push(warning.name));

// The app's own logger, made visible to the bridge (a no-op while the bridge is off).
const appLogger = { info: (...args) => args, error: (...args) => args };
addLogSource(loggerSource('app', appLogger));

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer() {
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    const route = new URL(request.url, 'http://x').pathname;
    if (route === '/redirect') {
      response.writeHead(302, { Location: '/ok' }).end();
    } else if (route === '/ok' || route === '/search') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    } else if (route === '/error') {
      response.writeHead(500, { 'Content-Type': 'text/plain' }).end('server error');
    } else {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** Requests of the main process itself: Node http, global fetch and Electron's net. */
async function mainFetches(port, refused) {
  const base = `http://127.0.0.1:${port}`;
  const viaHttp = await new Promise((resolve) =>
    http.get(`${base}/ok?from=http`, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }),
  );
  const viaFetch = (await fetch(`${base}/missing`)).status;
  const viaNet = (await net.fetch(`${base}/error`)).status;
  const refusedFetch = await fetch(`http://127.0.0.1:${refused}/refused`).then(
    () => 'ok',
    () => 'failed',
  );
  return [viaHttp, viaFetch, viaNet, refusedFetch];
}

/** A port nothing listens on (refused connections). */
function closedPort() {
  const probe = http.createServer();
  return new Promise((resolve) =>
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    }),
  );
}

runFixture(async () => {
  const port = await startServer();
  const refused = await closedPort();
  const window = await createFixtureWindow({
    file: path.join(__dirname, 'index.html'),
    name: 'app-logs',
    preload: path.join(__dirname, 'preload.cjs'),
  });
  const page = (script) => window.webContents.executeJavaScript(script);
  const extraWindow = (preload) => {
    const extra = new BrowserWindow({ show: false, webPreferences: preload ? { preload } : {} });
    return extra.loadFile(path.join(__dirname, 'index.html')).then(() => extra);
  };
  handleCommands({
    digest: () => digest,
    'main-throw': async () => {
      setTimeout(() => {
        throw new Error('main boom');
      });
      await settle();
      return digest;
    },
    // A bundled script with a source map (written by the test): its stack should map back to the source.
    'mapped-throw': async () => {
      const script = process.env.FIXTURE_MAPPED_SCRIPT;
      setTimeout(() => require(script).boom());
      await settle();
      return true;
    },
    'main-reject': async () => {
      void Promise.reject(new Error('main reject'));
      await settle();
      return digest;
    },
    'main-console': () => {
      console.log('main says %d', 7);
      console.error('main error line');
      return true;
    },
    'app-log': () => {
      appLogger.info('order %s saved', 'A-1');
      appLogger.error('order failed');
      return true;
    },
    'renderer-logs': () => page('window.logSome()'),
    fetches: () => page(`window.fetchAll(${port}, ${refused})`),
    'main-fetches': () => mainFetches(port, refused),
    burst: () => page('window.burst(8000)'),
    'crash-renderer': async () => {
      const extra = await extraWindow();
      // Killing the renderer process fires render-process-gone on every OS (forcefullyCrashRenderer does not on Linux CI).
      const gone = new Promise((resolve) => extra.webContents.once('render-process-gone', resolve));
      process.kill(extra.webContents.getOSProcessId(), 'SIGKILL');
      await gone;
      await settle();
      return true;
    },
    'broken-preload': async () => {
      await extraWindow(path.join(__dirname, 'broken-preload.cjs'));
      await settle();
      return true;
    },
  });
});
