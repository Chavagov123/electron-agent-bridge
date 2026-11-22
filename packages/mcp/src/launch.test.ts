import { BridgeError } from '@electron-agent-bridge/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli, type CliIo } from './cli/run-cli.js';
import { api, callText, closeClient, connectedClient, launches } from './testing/mcp-harness.js';

afterEach(closeClient);
beforeEach(() => {
  launches.length = 0;
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const sink: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    writeFile: () => undefined,
    now: () => 0,
  };
  return { sink, out, err };
}

describe('session action=launch', () => {
  it('launches, owns the app while connected elsewhere, and closes it with the session', async () => {
    const client = await connectedClient();
    const launched = await callText(client, 'session', {
      action: 'launch',
      executable: '/apps/electron',
      args: ['/apps/demo'],
      allowPackaged: true,
      strategy: 'inspector',
    });
    expect(launched.text).toMatch(/^Launched pid 4242 \(bridge injected via node-options\)\.\nApp: demo/);
    expect(launches[0]?.options).toEqual({
      executable: '/apps/electron',
      args: ['/apps/demo'],
      allowPackaged: true,
      strategy: 'inspector',
    });
    expect((await callText(client, 'session', { action: 'status' })).text).toContain(
      'Launched by this session: pid 4242',
    );
    await callText(client, 'session', { action: 'connect', pid: 4242 });
    expect(launches[0]?.closed).toBe(false);
    await callText(client, 'session', { action: 'close' });
    expect(launches[0]?.closed).toBe(true);
  });

  it('kills an app whose launch finishes after the session was closed', async () => {
    let finish: (() => void) | undefined;
    const slow = {
      ...api,
      launch: (options: Parameters<typeof api.launch>[0]) =>
        new Promise<Awaited<ReturnType<typeof api.launch>>>((resolve) => {
          finish = () => {
            void api.launch(options).then(resolve);
          };
        }),
    };
    const client = await connectedClient(slow);
    const pending = callText(client, 'session', { action: 'launch', executable: '/slow' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await callText(client, 'session', { action: 'close' });
    finish?.();
    expect((await pending).text).toMatch(
      /^Error \[NOT_FOUND\]: the session was closed while the app was launching/,
    );
    expect(launches[0]?.closed).toBe(true);
    expect((await callText(client, 'session', { action: 'status' })).text).toBe('Not connected.');
  });

  it('closes the previous launched app on the next launch, and needs an executable', async () => {
    const client = await connectedClient();
    await callText(client, 'session', { action: 'launch', executable: '/a' });
    await callText(client, 'session', { action: 'launch', executable: '/b' });
    expect(launches.map((launch) => launch.closed)).toEqual([true, false]);
    const missing = await callText(client, 'session', { action: 'launch' });
    expect(missing.text).toMatch(/^Error \[INVALID_PARAMS\]: launch needs `executable`/);
  });
});

describe('eab launch', () => {
  it('launches with flags and app args, then leaves the app running', async () => {
    const run = io();
    const code = await runCli(
      [
        'launch',
        '/apps/electron',
        '--allow-packaged',
        '--strategy',
        'node-options',
        '--timeoutMs',
        '9000',
        '--',
        '/apps/demo',
        '--flag',
      ],
      api,
      run.sink,
    );
    expect(code).toBe(0);
    expect(launches[0]).toMatchObject({
      options: {
        executable: '/apps/electron',
        args: ['/apps/demo', '--flag'],
        allowPackaged: true,
        strategy: 'node-options',
        timeoutMs: 9000,
      },
      detached: true,
      closed: false,
    });
    expect(run.out[0]).toContain(
      'Launched pid 4242 (bridge injected via node-options); the app keeps running.',
    );
    expect(run.out[0]).toContain('eab snapshot --pid 4242');
  });

  it('explains usage mistakes (exit 2) and launch failures (exit 1)', async () => {
    for (const argv of [['launch'], ['launch', '/a', '--strategy', 'magic'], ['launch', '/a', 'extra']]) {
      const run = io();
      expect(await runCli(argv, api, run.sink)).toBe(2);
      expect(run.err[0]).toMatch(/^Error \[INVALID_PARAMS\]/);
    }
    const blocked = io();
    const refusing = {
      ...api,
      launch: () =>
        Promise.reject(new BridgeError('LAUNCH_BLOCKED', 'fuses off', { hint: 'Use Integrated mode.' })),
    };
    expect(await runCli(['launch', '/a'], refusing, blocked.sink)).toBe(1);
    expect(blocked.err[0]).toBe('Error [LAUNCH_BLOCKED]: fuses off\nHint: Use Integrated mode.');
  });
});
