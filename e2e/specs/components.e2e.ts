import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { connect, type BridgeClient } from '@electron-agent-bridge/client';
import { handshakeFileName, type Locator } from '@electron-agent-bridge/core';
import { afterEach, describe, expect, it } from 'vitest';

import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture } from '../harness/launch-fixture.js';
import { startMcpClient, type McpTestClient } from '../harness/mcp-client.js';
import { versionModes } from '../harness/modes.js';
import { waitFor } from '../harness/wait.js';

describe.each(versionModes())('component state on Electron %s (%s mode)', (electron, mode) => {
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

  async function connected(): Promise<BridgeClient> {
    endpoint = isolatedEndpoint();
    app = await launchFixture({
      fixture: 'app-components',
      electron,
      mode,
      env: { ...endpoint.env, EAB_ENABLE: '1' },
    });
    const handshake = join(endpoint.directory, handshakeFileName(app.pid));
    await waitFor(() => existsSync(handshake), { what: 'handshake file' });
    client = await connect({ handshakePath: handshake });
    return client;
  }

  async function component(
    bridge: BridgeClient,
    locator: Locator,
    extra: { path?: string; component?: number } = {},
  ) {
    return (await bridge.call('state.component', { locator, ...extra })).data;
  }

  it('reads a React component’s props and hooks, and sees them change', async () => {
    const bridge = await connected();
    const button: Locator = { css: '#react-add' };
    await waitFor(async () => (await bridge.call('dom.find', { locator: button })).data.total === 1, {
      what: 'React rendered',
    });
    expect(await component(bridge, button)).toEqual({
      framework: 'react',
      chain: ['Counter', 'ReactApp'],
      name: 'Counter',
      value: { props: { label: 'Count' }, hooks: [0, []], otherHooks: 1 },
      truncated: false,
    });
    await bridge.call('action.run', { actions: [{ type: 'click', locator: button }] });
    expect((await component(bridge, button, { path: 'hooks' })).value).toEqual([1, ['added 1']]);
  });

  it('reads Vue 3 component props, setup state and data', async () => {
    const bridge = await connected();
    const milk: Locator = { role: 'checkbox', name: 'Milk' };
    await waitFor(async () => (await bridge.call('dom.find', { locator: milk })).data.total === 1, {
      what: 'Vue rendered',
    });
    expect(await component(bridge, milk)).toMatchObject({
      framework: 'vue',
      chain: ['TodoItem', 'TodoList'],
      name: 'TodoItem',
      value: { props: { title: 'Milk' }, state: { done: false } },
    });
    await bridge.call('action.run', { actions: [{ type: 'check', locator: milk }] });
    expect((await component(bridge, milk, { path: 'state.done' })).value).toBe(true);
    expect((await component(bridge, milk, { component: 1, path: 'state.items' })).value).toEqual([
      'Milk',
      'Bread',
    ]);
  });

  it('serves component reads through the MCP state tool', async () => {
    const bridge = await connected();
    await waitFor(
      async () => (await bridge.call('dom.find', { locator: { css: '#react-add' } })).data.total === 1,
      {
        what: 'React rendered',
      },
    );
    const ref = (await bridge.call('dom.find', { locator: { css: '#react-add' } })).data.matches[0]?.ref;
    mcp = await startMcpClient(endpoint!.env);
    await mcp.call('session', { action: 'connect', pid: app!.pid, role: 'observer' });
    const read = await mcp.call('state', { action: 'component', ref, path: 'props' });
    expect(read.text).toContain('Counter (react; around the element: Counter ← ReactApp) → props:');
    expect(read.text).toContain('"label": "Count"');
  });
});
