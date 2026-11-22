import { createServer } from 'node:net';

import { attach } from '@eab/attach';
import type { BridgeClient } from '@eab/client';
import { afterEach, describe, expect, it } from 'vitest';

import { selectedVersions } from '../harness/electron-versions.js';
import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture } from '../harness/launch-fixture.js';
import { mcpBinPath, startMcpClient, type McpTestClient } from '../harness/mcp-client.js';
import { waitFor } from '../harness/wait.js';

/** A port nothing listens on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

describe.each(selectedVersions())('Attach mode on Electron %s', (electron) => {
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

  /** app-basic without the bridge, reachable on a remote debugging port. */
  async function started(): Promise<number> {
    endpoint = isolatedEndpoint();
    const port = await freePort();
    app = await launchFixture({
      fixture: 'app-basic',
      electron,
      env: endpoint.env,
      args: [`--remote-debugging-port=${port}`],
    });
    return port;
  }

  it('snapshots, acts, waits and reads logs without the bridge in the app', async () => {
    const port = await started();
    client = await attach({ port });
    expect(client.session).toMatchObject({ mode: 'attach', features: ['pages', 'state'] });
    expect(client.session.app.electron).toMatch(/^\d+\./);
    const bridge = client;
    await waitFor(async () => (await bridge.call('targets.list', {})).data.targets.length > 0, {
      what: 'pages',
    });
    expect((await bridge.call('snapshot.take', {})).data.text).toMatch(/button "Save order"/);
    await bridge.call('logs.query', {});
    const acted = await bridge.call('action.run', {
      actions: [
        { type: 'fill', locator: { role: 'textbox', name: 'Customer' }, value: 'Ada' },
        { type: 'click', locator: { role: 'button', name: 'Save order' } },
      ],
    });
    expect(acted.data.steps.every((step) => step.ok)).toBe(true);
    await bridge.call('wait.for', { condition: { kind: 'text', text: 'Order saved' }, timeoutMs: 5_000 });
    await expect(bridge.call('ipc.query', {})).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(bridge.call('app.info', {})).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('attaches through MCP only when the operator allows it, and hides main-process tools', async () => {
    const port = await started();
    mcp = await startMcpClient(endpoint!.env);
    const refused = await mcp.call('session', { action: 'attach', port });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('--allow-eval');
    await mcp.close();
    mcp = await startMcpClient(endpoint!.env, [mcpBinPath(), '--allow-eval']);
    const attached = await mcp.call('session', { action: 'attach', port });
    expect(attached.text).toContain('Attached to renderers');
    const tools = (await mcp.client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toContain('snapshot');
    expect(tools).not.toContain('ipc');
    expect(tools).not.toContain('app');
    expect((await mcp.call('snapshot', {})).text).toContain('Save order');
  });
});
