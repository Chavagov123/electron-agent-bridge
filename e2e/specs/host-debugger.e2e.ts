import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { connect, type BridgeClient } from '@eab/client';
import { handshakeFileName, type TargetInfo } from '@eab/core';
import { afterEach, describe, expect, it } from 'vitest';

import { selectedVersions } from '../harness/electron-versions.js';
import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture } from '../harness/launch-fixture.js';
import { waitFor } from '../harness/wait.js';

describe.each(selectedVersions())('host app using webContents.debugger on Electron %s', (electron) => {
  let endpoint: IsolatedEndpoint | undefined;
  let app: LaunchedFixture | undefined;
  let client: BridgeClient | undefined;

  afterEach(async () => {
    client?.close();
    await app?.dispose();
    endpoint?.cleanup();
    [client, app, endpoint] = [undefined, undefined, undefined];
  });

  async function onlyTarget(bridge: BridgeClient): Promise<TargetInfo> {
    const [target] = (await bridge.call('targets.list', {})).data.targets;
    if (!target) throw new Error('no target');
    return target;
  }

  it('yields to the app, explains why, and takes the debugger back when the app lets go', async () => {
    endpoint = isolatedEndpoint();
    app = await launchFixture({
      fixture: 'app-host-debugger',
      electron,
      env: { ...endpoint.env, EAB_ENABLE: '1' },
    });
    const handshake = join(endpoint.directory, handshakeFileName(app.pid));
    await waitFor(() => existsSync(handshake), { what: 'handshake file' });
    client = await connect({ handshakePath: handshake });
    const bridge = client;
    expect(await onlyTarget(bridge)).toMatchObject({ attached: true });

    // The app's own attach succeeds and works exactly as without the bridge.
    expect(await app.command('attach')).toEqual({ command: 'attach', ok: true, result: 42 });
    expect(await onlyTarget(bridge)).toMatchObject({ attached: false, detachedReason: 'host-debugger' });
    await expect(bridge.call('snapshot.take', {})).rejects.toMatchObject({
      code: 'DETACHED',
      hint: expect.stringContaining('re-attaches when the app detaches') as unknown,
    });

    expect(await app.command('detach')).toEqual({ command: 'detach', ok: true, result: false });
    await waitFor(async () => (await onlyTarget(bridge)).attached, { what: 're-attach' });
    expect((await bridge.call('snapshot.take', {})).data.text).toContain('button "Ping"');
  });

  it('supports the app pattern "attach only if nobody is attached"', async () => {
    endpoint = isolatedEndpoint();
    app = await launchFixture({
      fixture: 'app-host-debugger',
      electron,
      env: { ...endpoint.env, EAB_ENABLE: '1' },
    });
    const handshake = join(endpoint.directory, handshakeFileName(app.pid));
    await waitFor(() => existsSync(handshake), { what: 'handshake file' });
    client = await connect({ handshakePath: handshake });
    const bridge = client;
    expect(await onlyTarget(bridge)).toMatchObject({ attached: true });
    expect(await app.command('attach-if-free')).toEqual({ command: 'attach-if-free', ok: true, result: 42 });
    expect(await onlyTarget(bridge)).toMatchObject({ attached: false, detachedReason: 'host-debugger' });
    expect(await app.command('detach')).toMatchObject({ ok: true });
    await waitFor(async () => (await onlyTarget(bridge)).attached, { what: 're-attach' });
  });

  it('the app can use its debugger as usual when the bridge is off', async () => {
    endpoint = isolatedEndpoint();
    app = await launchFixture({ fixture: 'app-host-debugger', electron, env: endpoint.env });
    expect(await app.command('attach')).toEqual({ command: 'attach', ok: true, result: 42 });
    expect(await app.command('detach')).toEqual({ command: 'detach', ok: true, result: false });
  });
});
