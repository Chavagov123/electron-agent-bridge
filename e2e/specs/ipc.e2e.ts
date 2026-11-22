import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { connect, type BridgeClient } from '@eab/client';
import { handshakeFileName, type BridgeError, type IpcEvent } from '@eab/core';
import { afterEach, describe, expect, it } from 'vitest';

import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture } from '../harness/launch-fixture.js';
import { startMcpClient, type McpTestClient } from '../harness/mcp-client.js';
import { versionModes } from '../harness/modes.js';
import { waitFor } from '../harness/wait.js';

describe.each(versionModes())('IPC capture on Electron %s (%s mode)', (electron, mode) => {
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

  async function started(bridge: boolean): Promise<LaunchedFixture> {
    endpoint = isolatedEndpoint();
    app = await launchFixture({
      fixture: 'app-ipc',
      electron,
      // Bridge off is only meaningful for Integrated mode (Launch always injects).
      mode: bridge ? mode : 'integrated',
      env: { ...endpoint.env, ...(bridge ? { EAB_ENABLE: '1' } : {}) },
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

  async function run(launched: LaunchedFixture): Promise<unknown> {
    const page = (await launched.command('scenario')).result;
    const main = (await launched.command('main-digest')).result;
    return { page, main };
  }

  it('leaves the app’s IPC behaviour exactly as without the bridge', async () => {
    const off = await run(await started(false));
    await app?.dispose();
    endpoint?.cleanup();
    const on = await run(await started(true));
    expect(on).toEqual(off);
    // A sanity check that the scenario exercised what it claims.
    expect(off).toMatchObject({
      page: {
        add: { ok: 5 },
        sync: { key: 'answer', value: 42 },
        replaced: { ok: 'second' },
        pageOnly: { ok: 'scoped' },
      },
      main: { logLines: ['first line', 'second line'], logSecond: 2, once: 1, removed: 0 },
    });
  });

  it('records requests, responses and errors with correlation, once per message', async () => {
    const { bridge, app: launched } = await connected();
    await launched.command('scenario');
    const { data } = await bridge.call('ipc.query', { limit: 500 });
    const on = (channel: string) => data.items.filter((event) => event.channel === channel);

    // invoke: main request + response share an id with the renderer's request (exact pairing).
    const add = on('math:add');
    const mainRequest = add.find((event) => event.side === 'main' && event.phase === 'request');
    const response = add.find((event) => event.phase === 'response' && event.side === 'main');
    const rendererRequest = add.find((event) => event.side === 'renderer' && event.phase === 'request');
    expect(mainRequest).toMatchObject({
      kind: 'invoke',
      argShape: 'number[2]',
      sender: { target: expect.stringMatching(/^wc\d+$/) as unknown },
    });
    expect(response).toMatchObject({ kind: 'handle', corr: mainRequest?.corr, argShape: 'number[1]' });
    expect(response?.durMs).toBeGreaterThanOrEqual(0);
    expect(rendererRequest).toMatchObject({
      kind: 'invoke',
      corr: mainRequest?.corr,
      correlation: 'exact',
      trust: 'high',
    });

    expect(on('math:fail').find((event) => event.phase === 'error' && event.side === 'main')?.argShape).toBe(
      'error: boom',
    );
    expect(on('math:reject').some((event) => event.phase === 'error' && event.side === 'main')).toBe(true);
    // No handler: only the renderer saw it, as an error.
    expect(on('no:handler').map((event) => [event.side, event.phase])).toEqual([
      ['renderer', 'request'],
      ['renderer', 'error'],
    ]);
    // handleOnce (Electron implements it with handle): one main-side request and response, not two.
    expect(
      on('once:handle')
        .filter((event) => event.side === 'main')
        .map((event) => event.phase),
    ).toEqual(['request', 'response']);
    // Two listeners, two messages: two main-side records, not four.
    expect(on('log:write').filter((event) => event.side === 'main')).toHaveLength(2);
    // sendSync: main sees the request and the value its listener returned, as does the renderer.
    expect(
      on('sync:get')
        .filter((event) => event.side === 'main')
        .map((event) => [event.kind, event.phase, event.argShape]),
    ).toEqual([
      ['sendSync', 'request', 'string[1]'],
      ['sendSync', 'response', expect.any(String)],
    ]);
    const mainSync = on('sync:get').filter((event) => event.side === 'main');
    expect(mainSync[0]?.corr).toBe(mainSync[1]?.corr);
    expect(
      on('sync:get')
        .filter((event) => event.side === 'renderer')
        .map((event) => [event.kind, event.phase]),
    ).toEqual([
      ['sendSync', 'request'],
      ['sendSync', 'response'],
    ]);
    // A removed listener: seen through the documented event (no wrapped listener), heuristic.
    expect(on('rm:listener').find((event) => event.side === 'main')).toMatchObject({
      correlation: 'heuristic',
    });
    expect(on('page:only').some((event) => event.side === 'main' && event.kind === 'handle')).toBe(true);
  });

  it('keeps values out unless the app opted the channel in, redacting secrets', async () => {
    const { bridge, app: launched } = await connected();
    await launched.command('scenario');
    const { data } = await bridge.call('ipc.query', { channel: 'settings:*' });
    const request = data.items.find((event: IpcEvent) => event.side === 'main' && event.phase === 'request');
    if (mode === 'integrated') {
      expect(request?.values).toEqual([{ theme: 'dark', password: '[redacted]' }]);
    } else {
      // Launch mode has no app options: shapes only.
      expect(request?.values).toBeUndefined();
    }
    const add = await bridge.call('ipc.query', { channel: 'math:add' });
    expect(add.data.items.every((event) => event.values === undefined)).toBe(true);
    expect(JSON.stringify(add.data)).not.toContain('hunter2');
  });

  it('lists the channel catalogue, outbound messages and bursts, and pages with newOnly', async () => {
    const { bridge, app: launched } = await connected();
    await launched.command('scenario');
    expect((await launched.command('push-ticks')).result).toEqual([1, 2, 3]);
    const ticks = await bridge.call('ipc.query', { channel: 'push:tick' });
    expect(ticks.data.items.map((event) => [event.kind, event.side])).toEqual([
      ['toRenderer', 'main'],
      ['toRenderer', 'main'],
      ['toRenderer', 'main'],
    ]);
    const catalogue = (await bridge.call('ipc.query', { limit: 1 })).data.channels.map(
      (entry) => entry.channel,
    );
    expect(catalogue).toEqual(
      expect.arrayContaining(['math:add', 'log:write', 'sync:get', 'push:tick', 'page:only']),
    );
    expect(catalogue.some((channel) => channel.startsWith('__eab'))).toBe(false);
    await launched.command('burst');
    await waitFor(
      async () =>
        (await bridge.call('ipc.query', { channel: 'burst:item', limit: 500 })).data.items.filter(
          (event) => event.side === 'main',
        ).length === 300,
      { what: '300 burst messages recorded' },
    );
  });

  it('reports the IPC an action caused and waits for a message', async () => {
    const { bridge, app: launched } = await connected();
    const acted = await bridge.call('action.run', {
      actions: [{ type: 'click', locator: { role: 'button', name: 'Add numbers' } }],
    });
    expect(acted.data.observations.ipc.map((event) => event.channel)).toContain('math:add');
    await launched.command('late-handler');
    const waited = await bridge.call('wait.for', {
      condition: { kind: 'ipc', channel: 'late:*' },
      timeoutMs: 5_000,
    });
    expect(waited.data.observed).toMatch(/on "late:handler"/);
  });

  it('leaves utility processes and MessagePorts working exactly as without the bridge', async () => {
    const off = (await (await started(false)).command('processes')).result;
    await app?.dispose();
    endpoint?.cleanup();
    const on = (await (await started(true)).command('processes')).result;
    expect(on).toEqual(off);
    expect(off).toEqual([
      { echo: { job: 1 }, ports: 0 },
      { echo: { job: 2 }, ports: 1 },
      { pong: { ping: 1 } },
    ]);
  });

  it('records utility process messages, MessagePort messages and contextBridge calls', async () => {
    const { bridge, app: launched } = await connected();
    await launched.command('processes');
    await launched.command('scenario');
    const query = async (channel: string): Promise<IpcEvent[]> =>
      (await bridge.call('ipc.query', { channel, limit: 500 })).data.items;
    await waitFor(async () => (await query('utility:echo')).length >= 4, { what: 'utility messages' });
    const utility = await query('utility:echo');
    expect(utility.map((event) => [event.kind, event.side, event.direction, event.argShape])).toEqual([
      ['utilityMessage', 'main', 'out', '{job: number}[1]'],
      ['utilityMessage', 'utility', 'in', '{echo: {job: number}, ports: number}[1]'],
      ['utilityMessage', 'main', 'out', '{job: number}[1]'],
      ['utilityMessage', 'utility', 'in', '{echo: {job: number}, ports: number}[1]'],
    ]);
    expect(utility[0]?.sender?.target).toMatch(/^u\d+$/);
    const ports = await query('port:*');
    expect(ports.map((event) => [event.kind, event.direction, event.argShape])).toEqual([
      ['portMessage', 'out', '{ping: number}[1]'],
      ['portMessage', 'in', '{pong: {ping: number}}[1]'],
    ]);
    const add = await query('bridge:api.add');
    expect(
      add.map((event) => [event.kind, event.side, event.phase, event.argShape, event.correlation]),
    ).toEqual([
      ['bridgeCall', 'renderer', 'request', 'number[2]', 'exact'],
      ['bridgeCall', 'renderer', 'response', 'number[1]', 'exact'],
    ]);
    expect(add[1]?.corr).toBe(add[0]?.corr);
    const inferred = await bridge.call('ipc.query', { channel: 'math:add', schemas: true, limit: 1 });
    expect(inferred.data.channels[0]?.schema).toMatchObject({
      request: '(a: number, b: number)',
      response: 'number',
    });
  });

  it('fails fast, naming the sendSync, on a page blocked waiting for the app to answer', async () => {
    const { bridge, app: launched } = await connected();
    await launched.command('block');
    await waitFor(
      async () => {
        const { data } = await bridge.call('ipc.query', { channel: 'sync:dialog', limit: 5 });
        return data.items.some((event) => event.side === 'main');
      },
      { what: 'the blocking sendSync' },
    );
    const started = Date.now();
    // Named: the dialog window the app opened could otherwise become the default target.
    const error = (await bridge
      .call('snapshot.take', { target: 'app-ipc' })
      .catch((caught: unknown) => caught)) as BridgeError;
    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toContain('ipcRenderer.sendSync("sync:dialog")');
    expect(error.hint).toContain('Answer that dialog');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await launched.command('unblock')).result).toBe(7);
    const { data } = await bridge.call('snapshot.take', { target: 'app-ipc' });
    expect(data.text).toContain('button');
  });

  it('serves the ipc tool through MCP with newOnly paging', async () => {
    const launched = await started(true);
    const handshake = join(endpoint!.directory, handshakeFileName(launched.pid));
    await waitFor(() => existsSync(handshake), { what: 'handshake file' });
    mcp = await startMcpClient(endpoint!.env);
    await mcp.call('session', { action: 'connect', pid: launched.pid });
    await launched.command('scenario');
    const first = await mcp.call('ipc', { newOnly: true });
    expect(first.text).toContain('math:add (handle/invoke');
    const again = await mcp.call('ipc', { newOnly: true });
    expect(again.text).toMatch(/^No IPC messages\./);
  });
});
