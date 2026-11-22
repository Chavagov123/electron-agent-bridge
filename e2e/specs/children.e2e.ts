import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { connect, type BridgeClient } from '@eab/client';
import { handshakeFileName, type LogEntry, type TargetInfo } from '@eab/core';
import { afterEach, describe, expect, it } from 'vitest';

import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture } from '../harness/launch-fixture.js';
import { versionModes } from '../harness/modes.js';
import { waitFor } from '../harness/wait.js';

describe.each(versionModes())('frames and workers on Electron %s (%s mode)', (electron, mode) => {
  let endpoint: IsolatedEndpoint | undefined;
  let app: LaunchedFixture | undefined;
  let client: BridgeClient | undefined;

  afterEach(async () => {
    client?.close();
    await app?.dispose();
    endpoint?.cleanup();
    [client, app, endpoint] = [undefined, undefined, undefined];
  });

  async function connected(): Promise<{ bridge: BridgeClient; app: LaunchedFixture }> {
    endpoint = isolatedEndpoint();
    app = await launchFixture({
      fixture: 'app-frames',
      electron,
      mode,
      env: { ...endpoint.env, EAB_ENABLE: '1' },
    });
    const handshake = join(endpoint.directory, handshakeFileName(app.pid));
    await waitFor(() => existsSync(handshake), { what: 'handshake file' });
    client = await connect({ handshakePath: handshake });
    return { bridge: client, app };
  }

  it('lists workers and the service worker as targets, without pages of their own', async () => {
    const { bridge } = await connected();
    let targets: TargetInfo[] = [];
    await waitFor(
      async () => {
        targets = (await bridge.call('targets.list', {})).data.targets;
        return targets.some((t) => t.kind === 'worker') && targets.some((t) => t.kind === 'serviceWorker');
      },
      { what: 'worker and service worker targets' },
    );
    const worker = targets.find((t) => t.kind === 'worker');
    expect(worker?.url).toMatch(/\/worker\.js$/);
    await expect(bridge.call('snapshot.take', { target: worker?.id })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    // The default target is still the window's page.
    expect((await bridge.call('snapshot.take', {})).data.text).toContain('Frames fixture');
  });

  it('collects console output and requests of workers and cross-site iframes', async () => {
    const { bridge, app: launched } = await connected();
    await bridge.call('logs.query', {});
    await bridge.call('network.query', {});
    let workerTarget: string | undefined;
    await waitFor(
      async () => {
        workerTarget = (await bridge.call('targets.list', {})).data.targets.find(
          (t) => t.kind === 'worker',
        )?.id;
        return workerTarget !== undefined;
      },
      { what: 'worker target' },
    );
    expect((await launched.command('ping')).result).toBe(200);
    let logs: LogEntry[] = [];
    await waitFor(
      async () => {
        logs = (await bridge.call('logs.query', { limit: 500 })).data.items;
        return logs.some((entry) => entry.text.startsWith('worker fetched'));
      },
      { what: 'worker console output' },
    );
    expect(logs.find((entry) => entry.text.startsWith('worker fetched'))).toMatchObject({ level: 'warn' });
    await waitFor(
      async () =>
        (await bridge.call('network.query', { url: '*from=worker*' })).data.items.some(
          (record) => record.status === 200,
        ),
      { what: 'the worker’s request' },
    );
  });
});
