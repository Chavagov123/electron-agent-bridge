import { execFile, execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { launch, type BridgeClient, type LaunchedApp } from '@eab/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { electronBinary, selectedVersions } from '../harness/electron-versions.js';
import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { eabBinPath } from '../harness/mcp-client.js';
import { killProcessTree } from '../harness/process-tree.js';
import { waitFor } from '../harness/wait.js';

/**
 * The OSS suite: pinned open-source apps (e2e/oss/apps.json), unmodified, in Launch mode,
 * driven through every surface an agent uses: targets, snapshots and deltas, find, a click, waits,
 * screenshots, logs, network, IPC, state, app info, and the `eab` CLI. Opt-in (`EAB_OSS=1`, optionally
 * `EAB_OSS_APPS=a,b`): it downloads and builds third-party projects, so it runs in the oss-apps workflow
 * (or locally where running those projects is acceptable), not in PR CI.
 */
const enabled = process.env['EAB_OSS'] === '1';
const prepare = join(dirname(fileURLToPath(import.meta.url)), '..', 'oss', 'prepare.mjs');
const only = (process.env['EAB_OSS_APPS'] ?? '').split(',').filter(Boolean);
const appNames = enabled
  ? (
      JSON.parse(readFileSync(join(dirname(prepare), 'apps.json'), 'utf8')) as { apps: { name: string }[] }
    ).apps
      .map((app) => app.name)
      .filter((name) => only.length === 0 || only.includes(name))
  : [];
type Prepared = { directory: string; args: string[]; ipc: boolean } | { error: string };
let prepared: Record<string, Prepared> = {};
const run = promisify(execFile);

beforeAll(() => {
  if (!enabled) return;
  prepared = JSON.parse(
    execFileSync(process.execPath, [prepare, ...appNames], { encoding: 'utf8', timeout: 2_400_000 }),
  ) as typeof prepared;
}, 2_400_000);

/** Chromium's console log lines that report errors, without positions (comparable across runs). */
function consoleErrors(log: string): Set<string> {
  const errors = new Set<string>();
  for (const line of log.split('\n')) {
    const message = /CONSOLE[(:]\d+\)?\] "(.*)", source: ([^\s(]*)/.exec(line);
    if (message?.[1] && /uncaught|error/i.test(message[1])) errors.add(`${message[1]} @ ${message[2] ?? ''}`);
  }
  return errors;
}

/** Console errors in the app's log that the run without the bridge did not have. */
function newErrors(baseline: Set<string>, logPath: string): string[] {
  return [...consoleErrors(readFileSync(logPath, 'utf8'))].filter((error) => !baseline.has(error));
}

/** Run the app without the bridge until its output is quiet, and return that output. */
async function withoutBridge(executable: string, args: readonly string[]): Promise<string> {
  const child = spawn(executable, args, {
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', EAB_ENABLE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let last = Date.now();
  const collect = (chunk: Buffer): void => {
    output += chunk.toString();
    last = Date.now();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const started = Date.now();
  await waitFor(() => Date.now() - last > 3_000 || Date.now() - started > 20_000, { timeoutMs: 25_000 });
  // Wait for it to be gone: apps with a single-instance lock (Ferdium) quit at once while it lives.
  const gone = new Promise((resolve) => child.once('exit', resolve));
  if (child.pid !== undefined) killProcessTree(child.pid);
  if (child.exitCode === null && child.signalCode === null) await gone;
  return output;
}

/** A link or button an agent could click without leaving or closing the app, or sending anything. */
const SAFE_TARGET =
  /- (?:link|button|tab|menuitem) "(?![^"]*\b(?:quit|exit|close|delete|remove|sign out|log ?out|uninstall|go|join|start|call|send|submit|save|connect)\b)[^"]+" [^\n]*\[(e\d+)\]/i;

/** A snapshot with refs that has stopped changing (apps render in stages after the first paint). */
async function pageText(client: BridgeClient): Promise<string> {
  let previous = '';
  return waitFor(
    async () => {
      const { data } = await client.call('snapshot.take', {});
      const settled = data.text === previous && /\[e\d+\]/.test(data.text);
      previous = data.text;
      if (!settled) await new Promise((resolve) => setTimeout(resolve, 1_000));
      return settled ? data.text : undefined;
    },
    { timeoutMs: 45_000, what: 'a settled snapshot with refs' },
  );
}

/** Click the first harmless link or button, as an agent would, and see what changed. */
async function clickSomething(
  client: BridgeClient,
  snapshot: string,
  report: Record<string, unknown>,
): Promise<void> {
  const cursor = (await client.call('snapshot.take', {})).data.cursor;
  const ref = SAFE_TARGET.exec(snapshot)?.[1];
  if (ref === undefined) return;
  const found = await client.call('dom.find', { locator: { ref } });
  expect(found.data.matches.length).toBe(1);
  const acted = await client.call('action.run', { actions: [{ type: 'click', locator: { ref } }] });
  const step = acted.data.steps[0];
  report['click'] = step?.ok === true ? `ok (${ref})` : step?.error?.code;
  // A click may legitimately be refused (covered, disabled): that must come back as a reason, not a crash.
  expect(step?.ok === true || step?.error?.code !== undefined).toBe(true);
  if (cursor !== undefined) {
    report['afterClick'] = (await client.call('snapshot.take', { mode: 'delta', since: cursor })).data.kind;
  }
}

/** Wait for text the page shows (met at once: the wait itself is what is tested). */
async function waitForShownText(client: BridgeClient): Promise<void> {
  // From the page as it is now: the click may have changed what is shown.
  const snapshot = (await client.call('snapshot.take', {})).data.text;
  const text = /"([A-Za-z][^"]{3,40})"/.exec(snapshot)?.[1];
  if (text === undefined) return;
  const waited = await client.call('wait.for', { condition: { kind: 'text', text }, timeoutMs: 5_000 });
  expect(waited.data.observed).toBeDefined();
}

const cases = selectedVersions().flatMap((electron) => appNames.map((name) => [name, electron] as const));

describe.skipIf(!enabled || cases.length === 0).each(cases)('OSS app %s on Electron %s', (name, electron) => {
  let endpoint: IsolatedEndpoint | undefined;
  let app: LaunchedApp | undefined;

  afterEach(async () => {
    await app?.close();
    endpoint?.cleanup();
    [app, endpoint] = [undefined, undefined];
  });

  it(
    'is found, read and driven unmodified through every surface, with no new console errors',
    { timeout: 240_000 },
    async () => {
      const target = prepared[name];
      if (!target) throw new Error(`${name} was not prepared`);
      if ('error' in target) throw new Error(`${name} could not be prepared: ${target.error}`);
      const executable = electronBinary(electron);
      const args = [target.directory, ...target.args];
      const baseline = consoleErrors(await withoutBridge(executable, args));

      endpoint = isolatedEndpoint();
      app = await launch({ executable, args, env: { ...endpoint.env, ELECTRON_ENABLE_LOGGING: '1' } });
      const { client } = app;
      const report: Record<string, unknown> = { strategy: app.strategy };

      // Pages and their names.
      const pages = await waitFor(
        async () => {
          const { data } = await client.call('targets.list', {});
          return data.targets.length > 0 ? data.targets : undefined;
        },
        { timeoutMs: 45_000, what: 'a page' },
      );
      report['pages'] = pages.map((page) => `${page.name} (${page.kind})`);

      // A full snapshot with refs; up to here the bridge only watched, so the page must log no errors
      // the run without the bridge did not. Then a delta after one click on something harmless.
      const snapshot = await pageText(client);
      report['snapshotLines'] = snapshot.split('\n').length;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const added = newErrors(baseline, app.logPath);
      await clickSomething(client, snapshot, report);
      await waitForShownText(client);

      // Screenshot, logs, network, IPC, state, app info.
      const shot = await client.call('screenshot.take', {});
      expect(shot.data.width).toBeGreaterThan(0);
      const logs = await client.call('logs.query', { limit: 500 });
      report['logs'] = logs.data.items.length;
      const network = await client.call('network.query', { limit: 500 });
      report['requests'] = network.data.items.length;
      const ipc = await client.call('ipc.query', { limit: 1 });
      report['ipcChannels'] = ipc.data.channels.length;
      if (target.ipc) expect(ipc.data.channels.length).toBeGreaterThan(0);
      const state = await client.call('state.read', {});
      report['stores'] = state.data.stores.map((store) => store.name);
      const info = await client.call('app.info', {});
      expect(info.data.windows.length).toBeGreaterThan(0);
      report['windows'] = info.data.windows.length;

      // The CLI against the same app (as an agent's shell or a CI job would use it).
      const cli = await run(process.execPath, [eabBinPath(), 'snapshot', '--pid', String(app.pid)], {
        env: { ...process.env, ...endpoint.env },
      });
      expect(cli.stdout).toMatch(/\[e\d+\]/);

      // Errors after the click are the app's reaction to a real user input: reported, not failed.
      report['errorsAfterClick'] = newErrors(baseline, app.logPath).filter((error) => !added.includes(error));
      process.stdout.write(`[oss] ${name} on Electron ${electron}: ${JSON.stringify(report)}\n`);
      expect(added).toEqual([]);
    },
  );
});

describe.skipIf(enabled)('OSS apps', () => {
  it.skip('run with EAB_OSS=1 (downloads and builds the pinned apps; see e2e/oss/apps.json)', () =>
    undefined);
});
