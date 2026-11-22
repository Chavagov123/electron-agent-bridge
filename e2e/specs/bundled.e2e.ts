import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { connect, type BridgeClient } from '@electron-agent-bridge/client';
import { handshakeFileName } from '@electron-agent-bridge/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { selectedVersions } from '../harness/electron-versions.js';
import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture } from '../harness/launch-fixture.js';
import { waitFor } from '../harness/wait.js';

const fixture = dirname(createRequire(import.meta.url).resolve('@eab-fixtures/app-bundled/package.json'));
const variants = ['inlined', 'external'] as const;

// Bundled against the built packages, like an app that installed them.
beforeAll(() => {
  execFileSync(process.execPath, [join(fixture, 'build.mjs')], { stdio: 'inherit', windowsHide: true });
});

describe.each(
  selectedVersions().flatMap((electron) => variants.map((variant) => [electron, variant] as const)),
)('bundled main on Electron %s (@electron-agent-bridge/electron %s)', (electron, variant) => {
  let endpoint: IsolatedEndpoint | undefined;
  let app: LaunchedFixture | undefined;
  let client: BridgeClient | undefined;

  afterEach(async () => {
    client?.close();
    await app?.dispose();
    endpoint?.cleanup();
    [client, app, endpoint] = [undefined, undefined, undefined];
  });

  it('works as when installed unbundled: pages, snapshots and IPC from both sides', async () => {
    const bundle = readFileSync(join(fixture, 'dist', `${variant}.cjs`), 'utf8');
    // The variant is what it claims: the runtime inside the bundle, or required at run time.
    expect(bundle.includes('require("@electron-agent-bridge/electron')).toBe(variant === 'external');
    endpoint = isolatedEndpoint();
    app = await launchFixture({
      fixture: 'app-bundled',
      electron,
      mode: 'integrated',
      env: { ...endpoint.env, EAB_ENABLE: '1', FIXTURE_VARIANT: variant },
    });
    const handshake = join(endpoint.directory, handshakeFileName(app.pid));
    await waitFor(() => existsSync(handshake), { what: 'handshake file' });
    client = await connect({ handshakePath: handshake });
    const snapshot = await client.call('snapshot.take', {});
    expect(snapshot.data.text).toMatch(/button "Bundled button" \[e\d+\]/);
    expect((await app.command('ping')).result).toBe('pong from page');
    const ipc = await client.call('ipc.query', { channel: 'bundled:ping' });
    // The handler registered after the bridge (main side) and the renderer preload (renderer side).
    expect(ipc.data.items.map((event) => `${event.side}:${event.kind}:${event.phase}`)).toEqual(
      expect.arrayContaining(['main:invoke:request', 'main:handle:response', 'renderer:invoke:request']),
    );
    expect(ipc.data.items.every((event) => event.internal !== true)).toBe(true);
  });
});
