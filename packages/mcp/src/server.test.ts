import { afterEach, describe, expect, it } from 'vitest';

import { api, callText, calls, closeClient, connectedClient, fakeClient } from './testing/mcp-harness.js';
import { SERVER_VERSION } from './server.js';

afterEach(closeClient);

describe('MCP server', () => {
  it('lists the v1 tools, without the eval-only ones before an eval session', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'session',
      'targets',
      'snapshot',
      'find',
      'act',
      'wait_for',
      'screenshot',
      'logs',
      'network',
      'ipc',
      'state',
      'app',
    ]);
  });

  it('hides the tools of feature groups the connection does not serve, and lists them again after it', async () => {
    const attached = fakeClient({}, { mode: 'attach', features: ['pages', 'state'] });
    const client = await connectedClient({ ...api, connect: () => Promise.resolve(attached) });
    const names = async (): Promise<string[]> => (await client.listTools()).tools.map((tool) => tool.name);
    expect(await names()).toContain('ipc');
    await callText(client, 'session', { action: 'connect' });
    expect(await names()).not.toEqual(expect.arrayContaining(['ipc']));
    expect(await names()).not.toContain('app');
    expect(await names()).toContain('state');
    const refused = await callText(client, 'ipc');
    expect(refused.isError).toBe(true);
    await callText(client, 'session', { action: 'close' });
    expect(await names()).toContain('ipc');
  });

  it('attaches over a debugging port only when the operator allowed eval', async () => {
    const ports: number[] = [];
    const attaching = {
      ...api,
      attach: (options: { port: number }) => {
        ports.push(options.port);
        return Promise.resolve(fakeClient({}, { mode: 'attach', features: ['pages', 'state'] }));
      },
    };
    const denied = await connectedClient(attaching);
    const refused = await callText(denied, 'session', { action: 'attach', port: 9222 });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain('--allow-eval');
    expect((await callText(denied, 'session', { action: 'attach' })).isError).toBe(true);
    await closeClient();
    const allowed = await connectedClient(attaching, { allowEval: true });
    expect((await callText(allowed, 'session', { action: 'attach', port: 9222 })).text).toContain(
      'Attached to renderers',
    );
    expect(ports).toEqual([9222]);
    expect((await allowed.listTools()).tools.map((tool) => tool.name)).not.toContain('ipc');
  });

  it('reports a typed error with a hint before connecting', async () => {
    const client = await connectedClient();
    const result = await callText(client, 'snapshot');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Error [NOT_FOUND]');
    expect(result.text).toContain('Hint:');
  });

  it('lists apps, connects, lists targets and snapshots with untrusted delimiters', async () => {
    const client = await connectedClient();
    expect((await callText(client, 'session', { action: 'list' })).text).toContain('pid 4242: demo 1.2.3');
    const connected = (await callText(client, 'session', { action: 'connect', role: 'controller' })).text;
    expect(connected).toContain('Role: controller');
    expect(connected).toContain('Capabilities: observe');
    expect((await callText(client, 'targets')).text).toBe(
      'wc1 window\n<untrusted-page-content>\nwc1 name=main title="Main" url=file:///a\n</untrusted-page-content>',
    );
    const snapshot = await callText(client, 'snapshot');
    expect(snapshot.text).toContain(
      'Target wc1 (1 lines)\n<untrusted-page-content>\ntitle: "Main"\nurl: file:///a\n- button "Go"\n</untrusted-page-content>',
    );
    expect(snapshot.text).toContain('- naive-snapshot: skeleton');
  });

  it('reports status, disconnects, and says when no apps run', async () => {
    const client = await connectedClient({ ...api, listInstances: () => [] });
    expect((await callText(client, 'session', { action: 'status' })).text).toBe('Not connected.');
    expect((await callText(client, 'session', { action: 'list' })).text).toContain('No bridge-enabled apps');
    await callText(client, 'session', { action: 'connect', pid: 4242 });
    expect((await callText(client, 'session', { action: 'status' })).text).toContain('connection open');
    expect((await callText(client, 'session', { action: 'close' })).text).toBe('Disconnected.');
    expect((await callText(client, 'targets')).isError).toBe(true);
  });

  it('renders empty and detached target lists', async () => {
    const empty = { data: { targets: [] }, limitations: [{ code: 'partial', message: 'starting' }] };
    const detached = {
      data: {
        targets: [
          {
            id: 'wc3',
            name: 'wc3',
            kind: 'webview',
            title: 'W',
            url: 'about:blank',
            attached: false,
            detachedReason: 'host-debugger',
          },
        ],
      },
      limitations: [],
    };
    let response: unknown = empty;
    const client = await connectedClient({
      ...api,
      connect: () => Promise.resolve(fakeClient({ 'targets.list': response })),
    });
    await callText(client, 'session', { action: 'connect' });
    expect((await callText(client, 'targets')).text).toBe(
      'The app has no pages yet.\n\nLimitations:\n- partial: starting',
    );
    response = detached;
    await callText(client, 'session', { action: 'connect' });
    expect((await callText(client, 'targets')).text).toContain('wc3 webview [detached: host-debugger]');
  });

  it('sends changes-only snapshots against the last cursor of the same page and scope', async () => {
    const client = await connectedClient();
    await callText(client, 'session', { action: 'connect' });
    calls.length = 0;
    await callText(client, 'snapshot', { changesOnly: true });
    await callText(client, 'snapshot', { changesOnly: true });
    await callText(client, 'snapshot', { changesOnly: true, root: 'e5', depth: 2, fidelity: 'ax' });
    expect(calls.map((call) => call.params)).toEqual([
      {},
      { mode: 'delta', since: 'c1' },
      { root: { ref: 'e5' }, depth: 2, fidelity: 'ax' },
    ]);
  });

  it('renders unchanged and delta snapshots', async () => {
    const delta = {
      data: {
        target: 'wc1',
        url: 'u',
        title: 't',
        kind: 'delta',
        cursor: 'c2',
        text: '+ - link "X" [e9]',
        lineCount: 4,
      },
      limitations: [],
      untrusted: true,
    };
    const unchanged = { ...delta, data: { ...delta.data, kind: 'unchanged', text: '' } };
    let response: unknown = delta;
    const client = await connectedClient({
      ...api,
      connect: () => Promise.resolve(fakeClient({ 'snapshot.take': response })),
    });
    await callText(client, 'session', { action: 'connect' });
    expect((await callText(client, 'snapshot')).text).toContain(
      'Target wc1: changes since the last snapshot (page has 4 lines)\n<untrusted-page-content>',
    );
    response = unchanged;
    await callText(client, 'session', { action: 'connect' });
    expect((await callText(client, 'snapshot')).text).toBe('Target wc1: no changes since the last snapshot.');
  });

  it('finds elements and asks for a locator when none is given', async () => {
    const client = await connectedClient();
    await callText(client, 'session', { action: 'connect' });
    expect((await callText(client, 'find', {})).text).toContain(
      'Error [INVALID_PARAMS]: give at least one of role, text or css',
    );
    calls.length = 0;
    const found = await callText(client, 'find', { role: 'button', name: 'Go', limit: 1 });
    expect(calls[0]).toEqual({
      method: 'dom.find',
      params: { locator: { role: 'button', name: 'Go' }, limit: 1 },
    });
    expect(found.text).toBe(
      '3 match(es)\n<untrusted-page-content>\n- button "Go" [e2]\n</untrusted-page-content>\n\nLimitations:\n- truncated: Showing 1 of 3 matches.',
    );
  });

  it('rejects invalid tool input', async () => {
    const client = await connectedClient();
    const result = await callText(client, 'session', { action: 'explode' });
    expect(result.isError).toBe(true);
  });
});

describe('SERVER_VERSION', () => {
  it('is the package version', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
