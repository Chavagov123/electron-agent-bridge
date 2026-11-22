import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { connect, type BridgeClient, type ConnectOptions } from '@eab/client';
import { handshakeFileName } from '@eab/core';
import { afterEach, describe, expect, it } from 'vitest';

import { isolatedEndpoint, type IsolatedEndpoint } from '../harness/endpoint-env.js';
import { launchFixture, type LaunchedFixture } from '../harness/launch-fixture.js';
import { startMcpClient, type McpTestClient } from '../harness/mcp-client.js';
import { versionModes } from '../harness/modes.js';
import { waitFor } from '../harness/wait.js';

describe.each(versionModes())('main-process control on Electron %s (%s mode)', (electron, mode) => {
  let endpoint: IsolatedEndpoint | undefined;
  let app: LaunchedFixture | undefined;
  const clients: BridgeClient[] = [];
  let mcp: McpTestClient | undefined;

  afterEach(async () => {
    await mcp?.close();
    for (const client of clients.splice(0)) client.close();
    await app?.dispose();
    endpoint?.cleanup();
    [mcp, app, endpoint] = [undefined, undefined, undefined];
  });

  /** The fixture with `eval` granted the way each mode grants it, or not at all. */
  async function started(withEval: boolean): Promise<string> {
    endpoint = isolatedEndpoint();
    app = await launchFixture({
      fixture: 'app-state',
      electron,
      mode,
      env: { ...endpoint.env, EAB_ENABLE: '1', ...(withEval ? { FIXTURE_EVAL: '1' } : {}) },
      ...(withEval ? { allowEval: true } : {}),
    });
    const handshake = join(endpoint.directory, handshakeFileName(app.pid));
    await waitFor(() => existsSync(handshake), { what: 'handshake file' });
    return handshake;
  }

  async function client(handshakePath: string, options: ConnectOptions = {}): Promise<BridgeClient> {
    const connected = await connect({ handshakePath, ...options });
    clients.push(connected);
    return connected;
  }

  it('reports the app and its windows, and controls them', async () => {
    const bridge = await client(await started(false));
    const info = (await bridge.call('app.info', {})).data;
    expect(info).toMatchObject({ name: expect.any(String) as unknown, isPackaged: false, pid: app!.pid });
    expect(info.electron.startsWith(electron)).toBe(true);
    const [window] = info.windows;
    expect(window).toMatchObject({ title: 'app-state', target: expect.stringMatching(/^wc\d+$/) as unknown });
    const resized = await bridge.call('window.control', {
      window: window!.id,
      action: 'setBounds',
      // Small enough for any CI screen (window managers clamp to the work area).
      bounds: { width: 640, height: 480 },
    });
    expect(resized.data.window?.bounds).toMatchObject({ width: 640, height: 480 });
    await bridge.call('menu.click', { path: ['Window', 'New Window'] });
    await waitFor(async () => (await app!.command('windows')).result === 2, { what: 'second window' });
    const extra = (await bridge.call('app.info', {})).data.windows.find((entry) => entry.id !== window!.id);
    expect(extra).toMatchObject({ visible: false });
    expect((await bridge.call('window.control', { window: extra!.id, action: 'close' })).data).toEqual({});
    await expect(bridge.call('window.control', { window: extra!.id, action: 'focus' })).rejects.toMatchObject(
      {
        code: 'NOT_FOUND',
      },
    );
  });

  it('clicks menu items by path or id, and refuses disabled or unknown ones', async () => {
    const bridge = await client(await started(true));
    await bridge.call('dialog.stub', {
      method: 'showOpenDialog',
      response: { filePaths: ['/tmp/report.csv'] },
    });
    expect((await bridge.call('menu.click', { id: 'file.open' })).data).toEqual({ label: 'Open…' });
    await waitFor(
      async () => ((await app!.command('digest')).result as { opened: unknown[] }).opened.length === 1,
      {
        what: 'open dialog answered',
      },
    );
    await expect(bridge.call('menu.click', { path: ['File', 'Export'] })).rejects.toMatchObject({
      code: 'DISABLED',
    });
    await expect(bridge.call('menu.click', { path: ['File', 'Print'] })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      hint: expect.stringContaining('"Open…"') as unknown,
    });
  });

  it('answers native dialogs from stubs (async and sync), then restores them on reset and on disconnect', async () => {
    const handshake = await started(true);
    const bridge = await client(handshake);
    await bridge.call('dialog.stub', { method: 'showOpenDialog', response: { filePaths: ['/tmp/a.txt'] } });
    await bridge.call('dialog.stub', { method: 'showSaveDialog', response: { filePath: '/tmp/out.txt' } });
    await bridge.call('dialog.stub', { method: 'showMessageBox', response: { response: 1 }, times: 2 });
    await bridge.call('menu.click', { path: ['File', 'Open…'] });
    await bridge.call('menu.click', { path: ['File', 'Save As…'] });
    await bridge.call('menu.click', { path: ['File', 'Ask'] });
    const digest = await waitFor(async () => {
      const result = (await app!.command('digest')).result as {
        opened: unknown[];
        saved: unknown[];
        asked: unknown[];
      };
      return result.opened.length === 1 ? result : undefined;
    });
    expect(digest).toEqual({
      opened: [{ canceled: false, filePaths: ['/tmp/a.txt'] }],
      saved: ['/tmp/out.txt'],
      asked: [1],
    });
    expect((await app!.command('dialogs-pristine')).result).toBe(false);
    await bridge.call('session.reset', {});
    expect((await app!.command('dialogs-pristine')).result).toBe(true);
    await bridge.call('dialog.stub', { method: 'showMessageBox', response: { response: 0 } });
    bridge.close();
    await waitFor(async () => (await app!.command('dialogs-pristine')).result === true, {
      what: 'stubs restored after disconnect',
    });
  });

  it('evaluates in the main process within a time limit, with secrets redacted and nothing in the audit', async () => {
    const handshake = await started(true);
    const bridge = await client(handshake);
    const name = await bridge.call('main.eval', { expression: 'app.getName()' });
    expect(name.data).toMatchObject({ type: 'string' });
    const windows = await bridge.call('main.eval', {
      expression:
        'const { BrowserWindow } = require("electron"); return BrowserWindow.getAllWindows().length',
    });
    expect(windows.data.value).toBe(1);
    const secret = await bridge.call('main.eval', { expression: '({ password: "hunter2", user: "ann" })' });
    expect(secret.data.value).toEqual({ password: '[redacted]', user: 'ann' });
    const thrown = await bridge.call('main.eval', { expression: 'null.x' });
    expect(thrown.data).toMatchObject({ type: 'error', value: { name: 'TypeError' } });
    await expect(
      bridge.call('main.eval', { expression: 'while (true) {}', timeoutMs: 200 }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    // The main process is still alive and responsive after the interrupted loop.
    expect((await bridge.call('app.info', {})).data.pid).toBe(app!.pid);
    const audit = readFileSync(join(endpoint!.directory, `audit-${app!.pid}.jsonl`), 'utf8');
    expect(audit).toContain('main.eval');
    expect(audit).not.toContain('hunter2');
    expect(audit).not.toContain('getAllWindows');
  });

  it('enforces capabilities: eval only when granted, interact not for observers or least-privilege clients', async () => {
    const handshake = await started(false);
    const controller = await client(handshake);
    expect(controller.session.capabilities).toEqual(['observe', 'interact']);
    for (const call of [
      () => controller.call('main.eval', { expression: '1' }),
      () => controller.call('dialog.stub', { method: 'showMessageBox', response: {} }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    }
    const observer = await client(handshake, { role: 'observer' });
    expect((await observer.call('app.info', {})).data.pid).toBe(app!.pid);
    expect((await observer.call('state.read', { store: 'prefs', path: 'theme' })).data.value).toBe('light');
    const interactions = [
      () => observer.call('window.control', { window: 1, action: 'focus' }),
      () => observer.call('menu.click', { path: ['Window', 'New Window'] }),
      () => observer.call('state.dispatch', { store: 'session', action: { type: 'x' } }),
    ];
    for (const call of interactions)
      await expect(call()).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    controller.close();
    const reader = await client(handshake, { capabilities: ['observe'] });
    await expect(reader.call('menu.click', { path: ['Window', 'New Window'] })).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
    });
  });

  it('lists the eval and dialogs tools in MCP only for a session that has eval', async () => {
    await started(true);
    mcp = await startMcpClient(endpoint!.env);
    await mcp.call('session', { action: 'connect', pid: app!.pid });
    const tools = (await mcp.client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(['eval', 'dialogs', 'app']));
    expect((await mcp.call('eval', { expression: '6 * 7' })).text).toContain('42');
    expect((await mcp.call('app', { action: 'info' })).text).toContain('app-state');
  });
});
