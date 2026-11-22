import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { handshakeFileName } from '@electron-agent-bridge/core';
import { afterEach, describe, expect, it } from 'vitest';

import { selectedVersions } from '../harness/electron-versions.js';
import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type FixtureName, type LaunchedFixture } from '../harness/launch-fixture.js';
import { eabBinPath, startMcpClient, type McpTestClient } from '../harness/mcp-client.js';
import { waitFor } from '../harness/wait.js';

const run = promisify(execFile);

/** PNG signature followed by the IHDR width and height. */
function pngSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, 'base64');
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe.each(selectedVersions())('MCP contract and CLI on Electron %s', (electron) => {
  let endpoint: IsolatedEndpoint | undefined;
  let app: LaunchedFixture | undefined;
  let mcp: McpTestClient | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    await mcp?.close();
    await app?.dispose();
    endpoint?.cleanup();
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    [mcp, app, endpoint, scratch] = [undefined, undefined, undefined, undefined];
  });

  async function launched(fixture: FixtureName = 'app-basic'): Promise<LaunchedFixture> {
    endpoint = isolatedEndpoint();
    app = await launchFixture({ fixture, electron, env: { ...endpoint.env, EAB_ENABLE: '1' } });
    const handshake = join(endpoint.directory, handshakeFileName(app.pid));
    await waitFor(() => existsSync(handshake), { what: 'handshake file' });
    return app;
  }

  async function connectedMcp(env: Record<string, string> = {}, args?: string[]): Promise<McpTestClient> {
    const started = await launched();
    mcp = await startMcpClient({ ...endpoint!.env, ...env }, args);
    const connected = await mcp.call('session', { action: 'connect', pid: started.pid });
    expect(connected.isError).toBe(false);
    return mcp;
  }

  it('lists the compact tools by default and every field with EAB_TOOL_PROFILE=full', async () => {
    const compact = await connectedMcp();
    const { tools } = await compact.client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'session',
      'targets',
      'snapshot',
      'find',
      'act',
      'wait_for',
      'screenshot',
      'logs',
      'network',
      'ipc',
      'state',
      'app',
    ]);
    const compactChars = JSON.stringify(tools).length;
    await compact.close();
    mcp = await startMcpClient({ ...endpoint!.env, EAB_TOOL_PROFILE: 'full' });
    const full = JSON.stringify((await mcp.client.listTools()).tools).length;
    expect(full).toBeGreaterThan(compactChars);
  });

  it('returns a real screenshot of the page and of one element', async () => {
    const client = (await connectedMcp()).client;
    const page = await client.callTool({ name: 'screenshot', arguments: {} });
    const [text, image] = page.content as [{ text: string }, { data: string; mimeType: string }];
    expect(text.text).toMatch(/^Screenshot \d+×\d+ \(image\/png\)\.$/);
    expect(image.mimeType).toBe('image/png');
    const pageSize = pngSize(image.data);
    expect(pageSize.width).toBeGreaterThan(400);
    const element = await client.callTool({
      name: 'screenshot',
      arguments: { locator: { role: 'button', name: 'Save order' } },
    });
    const [, button] = element.content as [unknown, { data: string }];
    const size = pngSize(button.data);
    expect(size.width).toBeLessThan(pageSize.width);
    expect(size.height).toBeLessThan(100);
  });

  it('serves every tool backend, and hides eval-tier tools from sessions without eval', async () => {
    const client = await connectedMcp();
    const state = await client.call('state', {});
    expect(state).toMatchObject({ isError: false });
    expect(state.text).toMatch(/^Stores: none found/);
    expect((await client.call('app', { action: 'info' })).text).toMatch(/\(pid \d+, development\)/);
    const tools = (await client.client.listTools()).tools.map((tool) => tool.name);
    expect(tools).not.toContain('eval');
    expect(tools).not.toContain('dialogs');
    expect((await client.call('targets')).isError).toBe(false);
  });

  it('rejects invalid input with every problem named', async () => {
    const client = await connectedMcp();
    const result = await client.call('act', { actions: [{ type: 'fill', locator: { ref: 'nope' } }] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Error [INVALID_PARAMS]: invalid input:');
    expect(result.text).toContain('actions.0.locator.ref');
    expect(result.text).toContain('actions.0.value');
  });

  it('serves MCP through `eab mcp` as well', async () => {
    const client = await connectedMcp({}, [eabBinPath(), 'mcp']);
    expect((await client.call('targets')).text).toMatch(/window/);
  });

  it('drives the app from the CLI: list, doctor, snapshot, act, screenshot', async () => {
    const started = await launched();
    const env = { ...process.env, ...endpoint!.env };
    const eab = (...args: string[]) => run(process.execPath, [eabBinPath(), ...args], { env });
    expect((await eab('list')).stdout).toContain(`pid ${started.pid}:`);
    expect((await eab('doctor')).stdout).toMatch(new RegExp(`OK {3}pid ${started.pid} `));
    expect((await eab('snapshot', '--pid', String(started.pid))).stdout).toMatch(
      /button "Save order" \[e\d+\]/,
    );
    const acted = await eab(
      'act',
      '--json',
      JSON.stringify({
        actions: [{ type: 'fill', locator: { role: 'textbox', name: 'Customer' }, value: 'Eve' }],
      }),
    );
    expect(acted.stdout).toMatch(/^1\. ✓ fill/);
    scratch = mkdtempSync(join(tmpdir(), 'eab-cli-'));
    const out = join(scratch, 'page.png');
    expect((await eab('screenshot', '--out', out)).stdout).toContain(`Image saved to ${out}`);
    expect(pngSize(readFileSync(out).toString('base64')).width).toBeGreaterThan(400);
    // Numeric-looking text stays text (a number would be INVALID_PARAMS).
    expect((await eab('logs', '--contains', '404')).stdout).toMatch(/^(No log entries\.|\d+ entr\(ies\))/);
    await expect(eab('find')).rejects.toMatchObject({ code: 1 });
    await expect(eab('explode')).rejects.toMatchObject({ code: 2 });
  });
});
