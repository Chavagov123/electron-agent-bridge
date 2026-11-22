'use strict';
// First: the bridge (off unless EAB_ENABLE=1). In Launch-mode tests the launcher injects it instead.
if (process.env.EAB_FIXTURE_MODE !== 'launch') require('@electron-agent-bridge/electron').enableAgentBridge();
const http = require('node:http');
const { createFixtureWindow, handleCommands, runFixture } = require('@eab-fixtures/fixture-kit');

// Service workers need an http(s) origin; the iframe comes from another site (localhost vs 127.0.0.1),
// so Chromium runs it in a process of its own.
const pages = {
  '/': (frame) =>
    `<!doctype html><html><head><title>app-frames</title></head><body><h1>Frames fixture</h1>
<iframe title="Remote" src="${frame}/frame"></iframe>
<script src="/page.js"></script></body></html>`,
  '/page.js': () =>
    `const worker = new Worker('/worker.js');
window.ping = () => new Promise((resolve) => { worker.onmessage = (e) => resolve(e.data); worker.postMessage('ping'); });
navigator.serviceWorker.register('/sw.js');`,
  '/worker.js': () =>
    `console.log('worker ready');
onmessage = async () => { const r = await fetch('/data?from=worker'); console.warn('worker fetched', r.status); postMessage(r.status); };`,
  '/sw.js': () =>
    `self.addEventListener('install', () => { console.log('service worker installed'); self.skipWaiting(); });`,
  '/frame': () =>
    `<!doctype html><html><body><button>In frame</button><script>console.log('frame ready')</script></body></html>`,
  '/data': () => '{"ok":true}',
};

function serve(host, frameOrigin) {
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, 'http://x').pathname;
    const page = pages[route];
    if (!page) return response.writeHead(404).end();
    const type = route.endsWith('.js')
      ? 'text/javascript'
      : route === '/data'
        ? 'application/json'
        : 'text/html';
    response.writeHead(200, { 'Content-Type': type }).end(page(frameOrigin));
  });
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

runFixture(async () => {
  const framePort = await serve('localhost', '');
  const port = await serve('127.0.0.1', `http://localhost:${framePort}`);
  const window = await createFixtureWindow({ url: `http://127.0.0.1:${port}/`, name: 'app-frames' });
  handleCommands({ ping: () => window.webContents.executeJavaScript('window.ping()') });
});
