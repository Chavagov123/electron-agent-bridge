import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, type BridgeClient } from '@electron-agent-bridge/client';
import { handshakeFileName, type LogEntry } from '@electron-agent-bridge/core';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture } from '../harness/launch-fixture.js';
import { startMcpClient, type McpTestClient } from '../harness/mcp-client.js';
import { versionModes } from '../harness/modes.js';
import { waitFor } from '../harness/wait.js';

describe.each(versionModes())('logs and network on Electron %s (%s mode)', (electron, mode) => {
  let endpoint: IsolatedEndpoint | undefined;
  let app: LaunchedFixture | undefined;
  let client: BridgeClient | undefined;
  let mcp: McpTestClient | undefined;

  afterEach(async () => {
    await mcp?.close();
    client?.close();
    await app?.dispose();
    endpoint?.cleanup();
    [mcp, client, app, endpoint] = [undefined, undefined, undefined, undefined];
  });

  async function started(bridge: boolean, env: Record<string, string> = {}): Promise<LaunchedFixture> {
    endpoint = isolatedEndpoint();
    app = await launchFixture({
      fixture: 'app-logs',
      electron,
      // Bridge off is only meaningful for Integrated mode (Launch always injects).
      mode: bridge ? mode : 'integrated',
      env: { ...endpoint.env, ...env, ...(bridge ? { EAB_ENABLE: '1' } : {}) },
    });
    return app;
  }

  async function connected(): Promise<{ bridge: BridgeClient; app: LaunchedFixture }> {
    const launched = await started(true);
    const handshake = join(endpoint!.directory, handshakeFileName(launched.pid));
    await waitFor(() => existsSync(handshake), { what: 'handshake file' });
    client = await connect({ handshakePath: handshake });
    return { bridge: client, app: launched };
  }

  /** Throw and reject in main, then report what the app itself saw. */
  async function crashDigest(bridge: boolean, appHandler: boolean): Promise<unknown> {
    const launched = await started(bridge, appHandler ? { FIXTURE_APP_HANDLER: '1' } : {});
    await launched.command('main-throw');
    const digest = (await launched.command('main-reject')).result;
    // Launch mode writes both streams to one log file (reported as stdout).
    const { stdout, stderr } = launched.output();
    const result = { digest, rejectionWarned: `${stdout}${stderr}`.includes('main reject') };
    await app?.dispose();
    endpoint?.cleanup();
    app = undefined;
    return result;
  }

  it('leaves crashes, error dialogs and rejection warnings exactly as without the bridge', async () => {
    for (const appHandler of [false, true]) {
      const off = await crashDigest(false, appHandler);
      const on = await crashDigest(true, appHandler);
      expect(on).toEqual(off);
      expect(off).toMatchObject(
        appHandler
          ? { digest: { handler: ['main boom'], errorBoxes: [] }, rejectionWarned: true }
          : {
              digest: { handler: [], errorBoxes: [expect.stringContaining('main boom')] },
              rejectionWarned: true,
            },
      );
    }
  });

  it('collects renderer, main, process and custom logs, including what was logged before the first query', async () => {
    const { bridge, app: launched } = await connected();
    for (const command of ['main-console', 'app-log', 'renderer-logs', 'crash-renderer', 'broken-preload']) {
      await launched.command(command);
    }
    await launched.command('main-throw');
    await launched.command('main-reject');
    const first = await bridge.call('logs.query', { limit: 500 });
    expect(first.limitations.map((limitation) => limitation.code)).toContain('partial');
    let items = first.data.items;
    const has = (source: LogEntry['source'], level: LogEntry['level'], text: RegExp) =>
      items.some((entry) => entry.source === source && entry.level === level && text.test(entry.text));
    // The page's console replays once capture starts; poll for what is still arriving.
    const arrived = waitFor(
      async () => {
        items = (await bridge.call('logs.query', { limit: 500 })).data.items;
        return (
          has('renderer', 'error', /^Uncaught Error: renderer boom/) &&
          has('process', 'error', /^Renderer process gone: /) &&
          has('renderer', 'error', /^Preload error: preload exploded$/)
        );
      },
      { what: 'renderer exception, crash and preload error' },
    );
    await arrived.catch((error: unknown) => {
      const seen = items.map((entry) => `${entry.source}/${entry.level}: ${entry.text.split('\n')[0] ?? ''}`);
      throw new Error(`${String(error)}\nlogged:\n${seen.join('\n')}`);
    });
    expect(has('renderer', 'info', /^renderer boot /)).toBe(true);
    expect(has('renderer', 'info', /^preload ready$/)).toBe(true);
    expect(has('renderer', 'warn', /^startup warning$/)).toBe(true);
    expect(has('renderer', 'info', /^info line #7$/)).toBe(true);
    expect(has('renderer', 'error', /^Error: logged error/)).toBe(true);
    expect(has('main', 'info', /^main says 7$/)).toBe(true);
    expect(has('main', 'error', /^main error line$/)).toBe(true);
    expect(has('main', 'error', /^Uncaught exception: main boom$/)).toBe(true);
    expect(has('main', 'warn', /^UnhandledPromiseRejectionWarning: /)).toBe(true);
    expect(has('custom', 'info', /^\[app\] order A-1 saved$/)).toBe(true);
    expect(has('custom', 'error', /^\[app\] order failed$/)).toBe(true);
    expect(has('process', 'error', /^Renderer process gone: /)).toBe(true);
    expect(has('renderer', 'error', /^Preload error: preload exploded$/)).toBe(true);
    const boom = items.find((entry) => entry.text.startsWith('Uncaught Error: renderer boom'));
    expect(boom).toMatchObject({
      target: 'app-logs',
      url: expect.stringContaining('renderer.js') as unknown,
    });
    expect(boom?.stack).toContain('renderer.js');

    const errors = await bridge.call('logs.query', { minLevel: 'error', source: 'main', limit: 500 });
    expect(errors.data.items.every((entry) => entry.level === 'error' && entry.source === 'main')).toBe(true);
    const mine = await bridge.call('logs.query', { target: 'app-logs', contains: 'BOOT' });
    expect(mine.data.items.map((entry) => entry.text)).toEqual([expect.stringMatching(/^renderer boot/)]);
  });

  it('caps a console flood, pages through what it kept and says how much it left out', async () => {
    const { bridge, app: launched } = await connected();
    await bridge.call('logs.query', { limit: 1 });
    await launched.command('burst');
    // Each page reports the messages left out within its own range: paging through adds them up.
    const capped = (limitations: readonly { readonly message: string }[]): number => {
      const note = limitations.find((limitation) => limitation.message.includes('were not recorded'));
      return Number(/^(\d+) console message/.exec(note?.message ?? '')?.[1] ?? 0);
    };
    let left = 0;
    let seen = 0;
    await waitFor(
      async () => {
        let cursor = 0;
        left = 0;
        seen = 0;
        for (let more = true; more;) {
          const page = await bridge.call('logs.query', { contains: 'burst', since: cursor, limit: 500 });
          seen += page.data.items.length + page.data.dropped;
          left += capped(page.limitations);
          cursor = page.data.nextSeq;
          more = page.data.more;
        }
        return left > 0 && seen + left >= 8_000;
      },
      { what: 'every burst line recorded or counted as left out' },
    );
    expect(left).toBeGreaterThan(1_000);
  });

  it('records request metadata from the first query on: status, failures, redirects, redacted secrets', async () => {
    const { bridge, app: launched } = await connected();
    const started = await bridge.call('network.query', {});
    expect(started.limitations[0]?.message).toContain('started with this query');
    expect((await launched.command('fetches')).result).toEqual([200, 404, 500, 200, 200, 'failed']);
    const urls = (await bridge.call('network.query', { limit: 100 })).data.items;
    const outcome = (path: string) =>
      urls.filter((record) => record.url.includes(path)).map((record) => record.failed ?? record.status);
    expect(outcome('/ok')).toEqual([200, 200]);
    expect(outcome('/missing')).toEqual([404]);
    expect(outcome('/error')).toEqual([500]);
    expect(outcome('/redirect')).toEqual([302]);
    expect(outcome('/refused')).toEqual(['net::ERR_CONNECTION_REFUSED']);
    const search = urls.find((record) => record.url.includes('/search'));
    expect(search?.url).toMatch(/\/search\?q=shoes&token=%5Bredacted%5D$/);
    expect(search).toMatchObject({ method: 'GET', target: 'app-logs', status: 200 });
    expect(search?.durMs).toBeGreaterThanOrEqual(0);
    const failed = await bridge.call('network.query', { failedOnly: true });
    expect(failed.data.items.map((record) => record.failed ?? record.status)).toEqual([
      404,
      500,
      'net::ERR_CONNECTION_REFUSED',
    ]);
    const glob = await bridge.call('network.query', { url: '*/missing', target: 'app-logs' });
    expect(glob.data.items).toHaveLength(1);
  });

  it('maps main-process stacks through source maps when logs are read', async () => {
    const scripts = mkdtempSync(join(tmpdir(), 'eab-mapped-'));
    const script = join(scripts, 'dist', 'thrower.js');
    const source = join(scripts, 'src', 'thrower.ts');
    buildSync({
      stdin: {
        contents: [
          'const pad: number = 1;',
          'export function boom(): never {',
          '  throw new Error("mapped " + pad);',
          '}',
          '',
        ].join('\n'),
        sourcefile: source,
        loader: 'ts',
      },
      outfile: script,
      format: 'cjs',
      sourcemap: true,
      write: true,
    });
    try {
      const launched = await started(true, { FIXTURE_MAPPED_SCRIPT: script });
      const handshake = join(endpoint!.directory, handshakeFileName(launched.pid));
      await waitFor(() => existsSync(handshake), { what: 'handshake file' });
      client = await connect({ handshakePath: handshake });
      await launched.command('mapped-throw');
      const entry = (await client.call('logs.query', { source: 'main', contains: 'mapped 1' })).data.items[0];
      expect(entry).toMatchObject({ level: 'error', mapped: true });
      expect(entry?.stack).toContain(`${source}:3:`);
    } finally {
      rmSync(scripts, { recursive: true, force: true });
    }
  });

  it('records the main process’s own requests as target main, without changing them', async () => {
    const off = (await (await started(false)).command('main-fetches')).result;
    await app?.dispose();
    endpoint?.cleanup();
    const { bridge, app: launched } = await connected();
    await bridge.call('network.query', {});
    expect((await launched.command('main-fetches')).result).toEqual(off);
    expect(off).toEqual([200, 404, 500, 'failed']);
    await waitFor(
      async () => (await bridge.call('network.query', { target: 'main', limit: 100 })).data.items.length >= 4,
      { what: 'main-process requests recorded' },
    );
    const main = (await bridge.call('network.query', { target: 'main', limit: 100 })).data.items;
    const row = (path: string) => main.find((record) => record.url.includes(path));
    expect(row('/ok?from=http')).toMatchObject({
      target: 'main',
      method: 'GET',
      status: 200,
      resourceType: 'Node http',
    });
    expect(row('/missing')).toMatchObject({ status: 404, resourceType: 'fetch', mimeType: 'text/plain' });
    expect(row('/error')).toMatchObject({ status: 500, resourceType: 'net' });
    expect(row('/refused')?.failed).toEqual(expect.any(String));
    expect(main.every((record) => record.target === 'main')).toBe(true);
  });

  it('serves the logs and network tools through MCP', async () => {
    const launched = await started(true);
    const handshake = join(endpoint!.directory, handshakeFileName(launched.pid));
    await waitFor(() => existsSync(handshake), { what: 'handshake file' });
    mcp = await startMcpClient(endpoint!.env);
    await mcp.call('session', { action: 'connect', pid: launched.pid });
    await launched.command('app-log');
    const logs = await mcp.call('logs', { source: 'custom', newOnly: true });
    expect(logs.text).toContain('info custom: [app] order A-1 saved');
    expect((await mcp.call('logs', { source: 'custom', newOnly: true })).text).toMatch(/^No log entries\./);
    await mcp.call('network', {});
    await launched.command('fetches');
    const network = await mcp.call('network', { failedOnly: true });
    expect(network.text).toMatch(/\[app-logs\] GET http:\/\/127\.0\.0\.1:\d+\/missing → 404/);
  });
});
