#!/usr/bin/env node
// Smoke test of the packages as users get them: install them from npm into a fresh project, start a
// tiny app that imports `@electron-agent-bridge/electron/register`, and check that `eab list` finds it
// and `eab snapshot` sees its button. CI tests the workspace build; this tests the published tarballs.
//
// Usage: node scripts/smoke-published.mjs [dist-tag or version, default latest] [Electron major, default 45]
// Linux needs a display (run under xvfb-run).
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [tag = 'latest', electronMajor = '45'] = process.argv.slice(2);
const windows = process.platform === 'win32';
const project = mkdtempSync(join(tmpdir(), 'eab-smoke-'));
// A private endpoint directory: `eab list` sees only this app.
const endpoint = mkdtempSync(windows ? join(tmpdir(), 'eab-smoke-endpoint-') : '/tmp/eab-smoke-');
const env = {
  ...process.env,
  ...(windows ? { TEMP: endpoint, TMP: endpoint } : { XDG_RUNTIME_DIR: endpoint }),
};

const run = (command, args) =>
  execFileSync(command, args, { cwd: project, env, encoding: 'utf8', shell: windows, windowsHide: true });
const step = (text) => console.log(`smoke: ${text}`);

let app;
try {
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ name: 'eab-smoke', private: true, main: 'main.cjs' }),
  );
  writeFileSync(
    join(project, 'main.cjs'),
    [
      "require('@electron-agent-bridge/electron/register');",
      "const { app, BrowserWindow } = require('electron');",
      'app.whenReady().then(() => {',
      // Off the screen: a local run does not cover your work.
      '  const window = new BrowserWindow({ width: 640, height: 400, x: -2000, y: -2000 });',
      "  window.loadURL('data:text/html,<title>smoke</title><button>Hello from npm</button>');",
      '});',
      "app.on('window-all-closed', () => app.quit());",
      '',
    ].join('\n'),
  );
  step(
    `installing @electron-agent-bridge/electron@${tag}, @electron-agent-bridge/mcp@${tag}, electron@${electronMajor}`,
  );
  run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    `@electron-agent-bridge/electron@${tag}`,
    `@electron-agent-bridge/mcp@${tag}`,
    `electron@${electronMajor}`,
  ]);
  const installed = createRequire(join(project, 'package.json'));
  step(`installed ${installed('@electron-agent-bridge/electron/package.json').version}`);

  const electron = installed('electron');
  app = spawn(electron, ['.'], {
    cwd: project,
    env: { ...env, EAB_ENABLE: '1' },
    stdio: 'ignore',
    detached: !windows,
    windowsHide: false,
  });
  const eab = (...args) => run('npx', ['--no-install', 'eab', ...args]);

  const deadline = Date.now() + 60_000;
  let listed = '';
  while (Date.now() < deadline) {
    listed = eab('list');
    if (listed.includes(String(app.pid))) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!listed.includes(String(app.pid))) throw new Error(`eab list never showed pid ${app.pid}:\n${listed}`);
  step(`eab list found the app (pid ${app.pid})`);

  let snapshot = '';
  for (let attempt = 0; attempt < 20 && !snapshot.includes('Hello from npm'); attempt++) {
    snapshot = eab('snapshot', '--pid', String(app.pid));
    if (!snapshot.includes('Hello from npm')) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!/button "Hello from npm"/.test(snapshot))
    throw new Error(`eab snapshot did not show the button:\n${snapshot}`);
  step('eab snapshot shows button "Hello from npm"');
  step('passed');
} finally {
  if (app?.pid !== undefined) {
    try {
      if (windows)
        execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      else process.kill(-app.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  // Electron's helper processes can hold files for a moment after the app exits (EBUSY on Windows).
  if (app !== undefined && app.exitCode === null) {
    await new Promise((resolve) => {
      app.once('exit', resolve);
      setTimeout(resolve, 5_000);
    });
  }
  for (const directory of [project, endpoint]) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (error) {
      console.warn(`smoke: could not remove ${directory} (${error.code}); it is a temporary directory`);
    }
  }
}
