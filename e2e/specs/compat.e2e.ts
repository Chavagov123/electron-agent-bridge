import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { connect, type BridgeClient } from '@eab/client';
import { PROTOCOL_VERSION, handshakeFileName, isProtocolCompatible } from '@eab/core';
import { afterEach, describe, expect, it } from 'vitest';

import { selectedVersions } from '../harness/electron-versions.js';
import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture } from '../harness/launch-fixture.js';
import { waitFor } from '../harness/wait.js';

/** `dist/index.cjs` of an older runtime (node e2e/compat/build-runtime.mjs <ref>); the test runs only with one. */
const runtime = process.env['EAB_COMPAT_RUNTIME'];
if (runtime === '') throw new Error('EAB_COMPAT_RUNTIME is empty: building the old runtime failed');

describe.skipIf(runtime === undefined).each(selectedVersions())(
  'current client against an older runtime on Electron %s',
  (electron) => {
    let endpoint: IsolatedEndpoint | undefined;
    let app: LaunchedFixture | undefined;
    let client: BridgeClient | undefined;

    afterEach(async () => {
      client?.close();
      await app?.dispose();
      endpoint?.cleanup();
      [client, app, endpoint] = [undefined, undefined, undefined];
    });

    it('connects, observes and acts; methods the old runtime lacks answer UNSUPPORTED, not a crash', async () => {
      endpoint = isolatedEndpoint();
      app = await launchFixture({
        fixture: 'app-basic',
        electron,
        mode: 'integrated',
        env: { ...endpoint.env, EAB_ENABLE: '1', EAB_FIXTURE_RUNTIME: dirname(runtime ?? '') },
      });
      const handshake = join(endpoint.directory, handshakeFileName(app.pid));
      await waitFor(() => existsSync(handshake), { what: 'handshake file' });
      const theirs = (JSON.parse(readFileSync(handshake, 'utf8')) as { protocolVersion: string })
        .protocolVersion;
      process.stdout.write(`[compat] runtime protocol ${theirs}, client ${PROTOCOL_VERSION}\n`);
      if (!isProtocolCompatible(PROTOCOL_VERSION, theirs)) {
        // Across an incompatible change the client refuses clearly instead of misbehaving.
        await expect(connect({ handshakePath: handshake })).rejects.toMatchObject({
          code: 'VERSION_MISMATCH',
        });
        return;
      }
      client = await connect({ handshakePath: handshake });
      expect((await client.call('targets.list', {})).data.targets.length).toBeGreaterThan(0);
      expect((await client.call('snapshot.take', {})).data.text).toMatch(/button "Save order" \[e\d+\]/);
      const acted = await client.call('action.run', {
        actions: [{ type: 'fill', locator: { role: 'textbox', name: 'Customer' }, value: 'Compat' }],
      });
      expect(acted.data.steps[0]?.ok).toBe(true);
      // Every method the current protocol table has either works or fails cleanly.
      for (const call of [
        () => client!.call('state.read', {}),
        () => client!.call('app.info', {}),
        () => client!.call('logs.query', {}),
      ]) {
        const outcome = await call().then(
          () => 'ok',
          (error: unknown) => (error as { code?: string }).code ?? 'thrown',
        );
        expect(['ok', 'UNSUPPORTED']).toContain(outcome);
      }
    });
  },
);
