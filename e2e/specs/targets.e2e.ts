import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { connect, type BridgeClient } from '@electron-agent-bridge/client';
import { handshakeFileName, type TargetInfo } from '@electron-agent-bridge/core';
import { afterEach, describe, expect, it } from 'vitest';

import { selectedVersions } from '../harness/electron-versions.js';
import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture } from '../harness/launch-fixture.js';
import { waitFor } from '../harness/wait.js';

describe.each(selectedVersions())('targets and naming on Electron %s', (electron) => {
  let endpoint: IsolatedEndpoint | undefined;
  let app: LaunchedFixture | undefined;
  let client: BridgeClient | undefined;

  afterEach(async () => {
    client?.close();
    await app?.dispose();
    endpoint?.cleanup();
    [client, app, endpoint] = [undefined, undefined, undefined];
  });

  async function connected(): Promise<BridgeClient> {
    endpoint = isolatedEndpoint();
    app = await launchFixture({ fixture: 'app-multi', electron, env: { ...endpoint.env, EAB_ENABLE: '1' } });
    const handshake = join(endpoint.directory, handshakeFileName(app.pid));
    await waitFor(() => existsSync(handshake), { what: 'handshake file' });
    client = await connect({ handshakePath: handshake });
    return client;
  }

  async function targets(bridge: BridgeClient): Promise<TargetInfo[]> {
    return (await bridge.call('targets.list', {})).data.targets;
  }

  it('lists windows, a view, a webview and a hidden window with stable, unique names', async () => {
    const bridge = await connected();
    const list = await targets(bridge);
    const byName = Object.fromEntries(list.map((target) => [target.name, target]));
    expect(Object.keys(byName).sort()).toEqual(['guest', 'multi-main', 'panel', 'preferences']);
    expect(byName['multi-main']).toMatchObject({ kind: 'window', attached: true });
    expect(byName['panel']).toMatchObject({ kind: 'view', attached: true });
    expect(byName['guest']).toMatchObject({ kind: 'webview', attached: true });
    // Explicit name from nameTarget() wins over the file name ("settings").
    expect(byName['preferences']).toMatchObject({ kind: 'window', title: 'Settings', attached: true });
    expect(new Set(list.map((target) => target.id)).size).toBe(list.length);
    // Stable across calls.
    expect((await targets(bridge)).map((target) => target.name)).toEqual(list.map((target) => target.name));
  });

  it('snapshots any target by name, including views, webviews and hidden windows', async () => {
    const bridge = await connected();
    const text = async (target?: string): Promise<string> =>
      (await bridge.call('snapshot.take', target === undefined ? {} : { target })).data.text;
    expect(await text()).toMatch(/heading "Main window" \[e\d+\] level=1/);
    expect(await text('guest')).toMatch(/button "Guest action" \[e\d+\]/);
    expect(await text('panel')).toMatch(/heading "Side panel" \[e\d+\] level=2/);
    expect(await text('Preferences')).toMatch(/checkbox "Dark mode" \[e\d+\]/);
  });

  it('tracks offscreen windows: listed, snapshotted, acted on and captured, never the default', async () => {
    const bridge = await connected();
    expect((await app!.command('open-offscreen')).result).toBe('offscreen');
    await waitFor(async () => (await targets(bridge)).some((target) => target.name === 'render'), {
      what: 'offscreen target',
    });
    expect((await targets(bridge)).find((target) => target.name === 'render')).toMatchObject({
      kind: 'offscreen',
    });
    expect((await bridge.call('snapshot.take', { target: 'render' })).data.text).toMatch(/button "Tick"/);
    await bridge.call('action.run', {
      target: 'render',
      actions: [{ type: 'click', locator: { role: 'button', name: 'Tick' } }],
    });
    expect((await bridge.call('snapshot.take', { target: 'render' })).data.text).toMatch(/button "Ticked"/);
    const shot = await bridge.call('screenshot.take', { target: 'render' });
    expect(shot.data.width).toBeGreaterThan(0);
    expect((shot.data.base64 ?? '').length + (shot.data.path ?? '').length).toBeGreaterThan(0);
    expect((await bridge.call('snapshot.take', {})).data.text).toMatch(/Main window/);
  });

  it('explains unknown targets with the names it knows', async () => {
    const bridge = await connected();
    await expect(bridge.call('snapshot.take', { target: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      hint: expect.stringContaining('preferences (wc') as unknown,
    });
  });
});
