import { existsSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { join } from 'node:path';

import { connect, listInstances } from '@electron-agent-bridge/client';
import { PROTOCOL_VERSION, encodeLine, handshakeFileName, type Handshake } from '@electron-agent-bridge/core';
import { afterEach, describe, expect, it } from 'vitest';

import { selectedVersions } from '../harness/electron-versions.js';
import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture } from '../harness/launch-fixture.js';
import { startMcpClient, type McpTestClient } from '../harness/mcp-client.js';
import { waitFor } from '../harness/wait.js';

/** Send one auth request on a fresh connection; resolve with the response and whether the app hung up. */
function rawAuth(endpoint: string, params: object): Promise<{ response: unknown; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(endpoint);
    let buffer = '';
    let response: unknown;
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('connect', () =>
      socket.write(encodeLine({ jsonrpc: '2.0', id: 1, method: 'session.auth', params })),
    );
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.includes('\n')) response = JSON.parse(buffer.split('\n')[0]!) as unknown;
    });
    socket.on('close', () => {
      resolve({ response, closed: true });
    });
  });
}

describe.each(selectedVersions())('walking skeleton (M1) on Electron %s', (electron) => {
  let endpoint: IsolatedEndpoint | undefined;
  let app: LaunchedFixture | undefined;
  let mcp: McpTestClient | undefined;

  afterEach(async () => {
    await mcp?.close();
    await app?.dispose();
    endpoint?.cleanup();
    [mcp, app, endpoint] = [undefined, undefined, undefined];
  });

  async function launch(
    extraEnv: Record<string, string>,
  ): Promise<{ app: LaunchedFixture; handshake: string }> {
    endpoint = isolatedEndpoint();
    app = await launchFixture({ fixture: 'app-basic', electron, env: { ...endpoint.env, ...extraEnv } });
    return { app, handshake: join(endpoint.directory, handshakeFileName(app.pid)) };
  }

  it('gate off: no endpoint directory, no handshake, no socket', async () => {
    const launched = await launch({});
    expect(launched.app.ready.fixture).toBe('app-basic');
    expect(existsSync(endpoint!.directory)).toBe(false);
    expect(launched.app.output().stderr).not.toContain('electron-agent-bridge');
  });

  it('MCP client connects over stdio, lists targets and takes a snapshot', async () => {
    const launched = await launch({ EAB_ENABLE: '1' });
    await waitFor(() => existsSync(launched.handshake), { what: 'handshake file' });

    mcp = await startMcpClient(endpoint!.env);
    const listed = await mcp.call('session', { action: 'list' });
    expect(listed.text).toContain(`pid ${launched.app.pid}:`);

    const connected = await mcp.call('session', { action: 'connect', pid: launched.app.pid });
    expect(connected.isError).toBe(false);
    expect(connected.text).toContain(`Electron ${launched.app.ready.electron}`);

    const targets = await mcp.call('targets');
    expect(targets.text).toMatch(/^wc\d+ window$/m);
    expect(targets.text).toMatch(
      /<untrusted-page-content>\nwc\d+ name=app-basic title="app-basic" url=file:\/\/.*index\.html\n/,
    );
    expect(targets.text).not.toContain('[detached]');

    const snapshot = await mcp.call('snapshot');
    expect(snapshot.isError).toBe(false);
    expect(snapshot.text).toContain('<untrusted-page-content>');
    // `[eN]` refs vary; everything else about each line is fixed.
    for (const line of [
      /navigation "Primary" \[e\d+\]/,
      /link "Orders" \[e\d+\]/,
      /heading "Basic fixture" \[e\d+\] level=1/,
      /textbox "Customer" \[e\d+\]/,
      /spinbutton "Quantity" \[e\d+\]: "1"/,
      /combobox "Priority" \[e\d+\]: "Normal"/,
      /radio "Pickup" \[e\d+\] checked/,
      /checkbox "Gift wrap" \[e\d+\]/,
      /textbox "Rich notes" \[e\d+\]/,
      /button "Save order" \[e\d+\]/,
      /button "Archive" \[e\d+\] disabled/,
    ]) {
      expect(snapshot.text).toMatch(line);
    }
    expect(snapshot.text).not.toContain('naive-snapshot');

    // Changes only: nothing happened, so nothing to report.
    const again = await mcp.call('snapshot', { changesOnly: true });
    expect(again.text).toMatch(/no changes since the last snapshot/);
  });

  it('rejects a wrong token and an incompatible protocol version, then hangs up', async () => {
    const launched = await launch({ EAB_ENABLE: '1' });
    await waitFor(() => existsSync(launched.handshake), { what: 'handshake file' });
    const [instance] = listInstances(endpoint!.directory);
    expect(instance?.handshake.pid).toBe(launched.app.pid);
    const { endpoint: socket, token } = instance!.handshake;
    const client = { name: 'e2e', version: '0' };

    const badToken = await rawAuth(socket, { token: `${token}x`, protocolVersion: PROTOCOL_VERSION, client });
    expect(badToken.response).toMatchObject({ error: { data: { code: 'UNAUTHORIZED' } } });
    expect(badToken.closed).toBe(true);

    const badVersion = await rawAuth(socket, { token, protocolVersion: '99.0.0', client });
    expect(badVersion.response).toMatchObject({ error: { data: { code: 'VERSION_MISMATCH' } } });
    expect(badVersion.closed).toBe(true);

    // A forged handshake pointing at the real endpoint with the wrong token fails the same way.
    const forged: Handshake = { ...instance!.handshake, token: 'forged-token-abcdefghij' };
    const forgedPath = join(endpoint!.directory, 'forged.json');
    writeFileSync(forgedPath, JSON.stringify(forged), { mode: 0o600 });
    await expect(connect({ handshakePath: forgedPath })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('the programmatic client sees the same app; dead apps disappear from discovery', async () => {
    const launched = await launch({ EAB_ENABLE: '1' });
    await waitFor(() => existsSync(launched.handshake), { what: 'handshake file' });
    const client = await connect({ directory: endpoint!.directory });
    try {
      const { data } = await client.call('targets.list', {});
      expect(data.targets).toHaveLength(1);
      expect(client.session.capabilities).toEqual(['observe', 'interact']);
    } finally {
      client.close();
    }
    await launched.app.dispose();
    expect(listInstances(endpoint!.directory)).toEqual([]);
  });
});
