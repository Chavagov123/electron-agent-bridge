import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { connect, type BridgeClient } from '@electron-agent-bridge/client';
import { handshakeFileName } from '@electron-agent-bridge/core';
import { afterEach, describe, expect, it } from 'vitest';

import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture } from '../harness/launch-fixture.js';
import { startMcpClient, type McpTestClient } from '../harness/mcp-client.js';
import { versionModes } from '../harness/modes.js';
import { waitFor } from '../harness/wait.js';

describe.each(versionModes())('state on Electron %s (%s mode)', (electron, mode) => {
  let endpoint: IsolatedEndpoint | undefined;
  let app: LaunchedFixture | undefined;
  let client: BridgeClient | undefined;
  let mcp: McpTestClient | undefined;
  // The devtools shim is an app option: only Integrated mode turns it on in this fixture.
  const shim = mode === 'integrated';

  afterEach(async () => {
    await mcp?.close();
    client?.close();
    await app?.dispose();
    endpoint?.cleanup();
    [mcp, client, app, endpoint] = [undefined, undefined, undefined, undefined];
  });

  async function connected(stateShim?: boolean): Promise<BridgeClient> {
    endpoint = isolatedEndpoint();
    app = await launchFixture({
      fixture: 'app-state',
      electron,
      mode,
      env: { ...endpoint.env, EAB_ENABLE: '1' },
      ...(stateShim === undefined ? {} : { stateShim }),
    });
    const handshake = join(endpoint.directory, handshakeFileName(app.pid));
    await waitFor(() => existsSync(handshake), { what: 'handshake file' });
    client = await connect({ handshakePath: handshake });
    return client;
  }

  const click = (bridge: BridgeClient, name: string) =>
    bridge.call('action.run', { actions: [{ type: 'click', locator: { role: 'button', name } }] });

  it('finds every store kind, registered or built with devtools support', async () => {
    const bridge = await connected();
    const { data } = await bridge.call('state.read', { store: 'session' });
    const stores = data.stores.map(({ name, kind }) => `${name}:${kind}`);
    expect(stores).toEqual(
      expect.arrayContaining(['session:redux', 'prefs:zustand', 'todos:mobx', 'model:generic']),
    );
    expect(stores.includes('cart:redux')).toBe(shim);
    expect(stores.includes('ui:generic')).toBe(shim);
    expect(data.value).toEqual({ user: null, token: '[redacted]', loggedIn: false });
  });

  it.runIf(mode === 'launch')('lets a launcher turn the devtools shim on for an unmodified app', async () => {
    const bridge = await connected(true);
    const { data } = await bridge.call('state.read', {});
    const stores = data.stores.map(({ name, kind }) => `${name}:${kind}`);
    expect(stores).toEqual(expect.arrayContaining(['cart:redux', 'ui:generic', 'session:redux']));
  });

  it('reads by path, redacts secrets and bounds deep or large values', async () => {
    const bridge = await connected();
    const title = await bridge.call('state.read', { store: 'todos', path: 'items[0].title' });
    expect(title.data).toMatchObject({
      store: 'todos',
      path: 'items[0].title',
      value: 'Write docs',
      truncated: false,
    });
    const todos = await bridge.call('state.read', { store: 'todos' });
    expect(todos.data.value).toMatchObject({ apiKey: '[redacted]' });
    expect(todos.limitations.map((limitation) => limitation.code)).toContain('redacted');
    const model = await bridge.call('state.read', { store: 'model', maxDepth: 3 });
    expect(model.data.truncated).toBe(true);
    expect(model.data.value).toMatchObject({
      password: '[redacted]',
      deep: { level1: { level2: '[object]' } },
    });
    await expect(bridge.call('state.read', { store: 'model', path: 'deep.nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(bridge.call('state.read', { store: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('dispatches to Redux and to stores registered with a dispatch function, refuses the rest', async () => {
    const bridge = await connected();
    await bridge.call('state.dispatch', {
      store: 'session',
      action: { type: 'session/login', payload: 'ann' },
    });
    expect((await bridge.call('state.read', { store: 'session', path: 'user' })).data.value).toBe('ann');
    await bridge.call('state.dispatch', { store: 'prefs', action: { type: 'setTheme', theme: 'dark' } });
    expect((await bridge.call('state.read', { store: 'prefs', path: 'theme' })).data.value).toBe('dark');
    await expect(
      bridge.call('state.dispatch', { store: 'todos', action: { type: 'x' } }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    if (shim) {
      // Zustand's devtools middleware applies `__setState` sent through the extension.
      await bridge.call('state.dispatch', {
        store: 'ui',
        action: { type: '__setState', state: { open: true } },
      });
      expect((await bridge.call('state.read', { store: 'ui', path: 'open' })).data.value).toBe(true);
    }
  });

  it('sees what the UI changes: thunks, Zustand setters, MobX actions, and waits for it', async () => {
    const bridge = await connected();
    await click(bridge, 'Add to cart');
    const waited = await bridge.call('wait.for', {
      condition: { kind: 'state', store: 'session', path: 'loggedIn', equals: false },
    });
    expect(waited.data.observed).toBe('loggedIn = false');
    if (shim) {
      await bridge.call('wait.for', {
        condition: { kind: 'state', store: 'cart', path: 'count', equals: 1 },
      });
      const cart = await bridge.call('state.read', { store: 'cart' });
      expect(cart.data.value).toEqual({ items: ['apple'], count: 1 });
      expect(cart.data.stores.find((store) => store.name === 'cart')?.actions).toBe(1);
      await click(bridge, 'Toggle panel');
      expect((await bridge.call('state.read', { store: 'ui', path: 'open' })).data.value).toBe(true);
    }
    await click(bridge, 'Finish first todo');
    await bridge.call('wait.for', {
      condition: {
        kind: 'state',
        store: 'todos',
        path: 'items[0]',
        equals: { id: 1, title: 'Write docs', done: true },
      },
    });
    await expect(
      bridge.call('wait.for', {
        condition: { kind: 'state', store: 'prefs', path: 'theme', equals: 'blue' },
        timeoutMs: 300,
      }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringContaining('theme = "light"') as unknown,
    });
  });

  it('keeps stores across a reload, and serves the state tool through MCP', async () => {
    const bridge = await connected();
    await bridge.call('state.dispatch', { store: 'prefs', action: { type: 'setTheme', theme: 'dark' } });
    // A new document gets the hook again before its scripts: the stores register anew.
    await app!.command('reload');
    // Hand the controller slot to the MCP session.
    bridge.close();
    mcp = await startMcpClient(endpoint!.env);
    await mcp.call('session', { action: 'connect', pid: app!.pid });
    const text = await waitFor(async () => {
      const result = await mcp!.call('state', { store: 'prefs' });
      return result.text.includes('"theme": "light"') ? result.text : undefined;
    });
    expect(text).toContain('prefs (zustand)');
    const dispatched = await mcp.call('state', {
      action: 'dispatch',
      store: 'session',
      dispatch: { type: 'session/login', payload: 'bo' },
    });
    expect(dispatched.text).toBe('Dispatched to session.');
  });
});
