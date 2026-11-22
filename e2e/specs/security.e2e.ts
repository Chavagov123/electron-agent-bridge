import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, type BridgeClient } from '@eab/client';
import { handshakeFileName } from '@eab/core';
import { afterEach, describe, expect, it } from 'vitest';

import { selectedVersions } from '../harness/electron-versions.js';
import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture } from '../harness/launch-fixture.js';
import { waitFor } from '../harness/wait.js';

describe.each(selectedVersions())('sessions, audit and secrets on Electron %s', (electron) => {
  let endpoint: IsolatedEndpoint | undefined;
  let app: LaunchedFixture | undefined;
  const clients: BridgeClient[] = [];
  const extraDirs: string[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const directory of extraDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
    await app?.dispose();
    endpoint?.cleanup();
    [app, endpoint] = [undefined, undefined];
  });

  async function launch(env: Record<string, string> = {}): Promise<string> {
    endpoint = isolatedEndpoint();
    app = await launchFixture({
      fixture: 'app-basic',
      electron,
      env: { ...endpoint.env, EAB_ENABLE: '1', ...env },
    });
    const handshake = env['EAB_HANDSHAKE'] ?? join(endpoint.directory, handshakeFileName(app.pid));
    await waitFor(() => existsSync(handshake), { what: 'handshake file' });
    return handshake;
  }

  async function open(
    handshakePath: string,
    options: Parameters<typeof connect>[0] = {},
  ): Promise<BridgeClient> {
    const client = await connect({ handshakePath, ...options });
    clients.push(client);
    return client;
  }

  it('one controller at a time; others observe; control passes on when the controller leaves', async () => {
    const handshake = await launch();
    const controller = await open(handshake, { client: { name: 'agent-a', version: '1' } });
    expect(controller.session).toMatchObject({ role: 'controller', capabilities: ['observe', 'interact'] });

    const observer = await open(handshake, { client: { name: 'agent-b', version: '1' } });
    expect(observer.session).toMatchObject({ role: 'observer', capabilities: ['observe'] });
    await expect(observer.call('targets.list', {})).resolves.toBeDefined();

    controller.close();
    const next = await waitFor(
      async () => {
        const candidate = await open(handshake);
        return candidate.session.role === 'controller' ? candidate : false;
      },
      { what: 'controller slot to free up' },
    );
    expect(next.session.capabilities).toEqual(['observe', 'interact']);
  });

  it('grants least privilege on request', async () => {
    const handshake = await launch();
    const client = await open(handshake, { capabilities: ['observe'], role: 'observer' });
    expect(client.session).toMatchObject({ role: 'observer', capabilities: ['observe'] });
  });

  it('audits calls with metadata only, owner-only, in the endpoint directory', async () => {
    const handshake = await launch();
    const client = await open(handshake, { client: { name: 'auditor', version: '1' } });
    await client.call('targets.list', {});
    await expect(client.call('main.eval', { expression: '"app-basic"' })).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
    });
    const auditPath = join(endpoint!.directory, `audit-${app!.pid}.jsonl`);
    const entries = await waitFor(() => {
      const lines = existsSync(auditPath) ? readFileSync(auditPath, 'utf8').trim().split('\n') : [];
      return lines.length >= 3 ? lines.map((line) => JSON.parse(line) as Record<string, unknown>) : false;
    });
    expect(entries.map((entry) => [entry['method'], entry['ok'], entry['client']])).toEqual([
      ['session.auth', true, 'auditor'],
      ['targets.list', true, 'auditor'],
      ['main.eval', false, 'auditor'],
    ]);
    const raw = readFileSync(auditPath, 'utf8');
    expect(raw).not.toContain(client.handshake.token);
    expect(raw).not.toContain('app-basic');
  });

  it('can turn the audit log off', async () => {
    await launch({ EAB_AUDIT: '0' });
    expect(existsSync(join(endpoint!.directory, `audit-${app!.pid}.jsonl`))).toBe(false);
  });

  it('uses a pre-shared token and handshake path, and hides the token from the app environment', async () => {
    const token = 'preshared-token-0123456789abcdef';
    const privateDir = mkdtempSync(join(tmpdir(), 'eab-hs-'));
    extraDirs.push(privateDir);
    const handshake = await launch({ EAB_TOKEN: token, EAB_HANDSHAKE: join(privateDir, 'app.json') });
    const client = await open(handshake);
    expect(client.handshake.token).toBe(token);
    // Child processes the app spawns inherit its environment: the token must not be there.
    expect(await app!.command('env-token')).toEqual({ command: 'env-token', ok: true, result: null });
  });
});
