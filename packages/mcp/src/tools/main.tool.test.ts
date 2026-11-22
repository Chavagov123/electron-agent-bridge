import { afterEach, describe, expect, it } from 'vitest';

import { api, callText, calls, closeClient, connectedClient, fakeClient } from '../testing/mcp-harness.js';

afterEach(closeClient);

async function connectedWith(
  overrides: Record<string, unknown>,
  capabilities = ['observe', 'interact', 'eval'],
) {
  const client = await connectedClient({
    ...api,
    connect: () => {
      const bridge = fakeClient(overrides);
      Object.assign(bridge.session, { capabilities });
      return Promise.resolve(bridge);
    },
  });
  await callText(client, 'session', { action: 'connect' });
  calls.length = 0;
  return client;
}

const window1 = {
  id: 1,
  target: 'wc1',
  title: 'Main',
  visible: true,
  focused: true,
  minimized: false,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
};

describe('state tool', () => {
  it('lists stores and reads a value; dispatches; needs the action object', async () => {
    const client = await connectedWith({
      'state.read': {
        data: {
          stores: [{ name: 'app', kind: 'redux' }],
          store: 'app',
          path: 'cart.items',
          value: [1, 2],
          truncated: true,
        },
        limitations: [],
      },
      'state.dispatch': { data: { dispatched: true }, limitations: [] },
    });
    const read = await callText(client, 'state', { path: 'cart.items' });
    expect(read.text).toBe(
      '<untrusted-page-content>\nStores: app (redux)\napp → cart.items:\n[\n  1,\n  2\n]\n</untrusted-page-content>\n' +
        '(value cut to fit; read a deeper path or raise maxDepth)',
    );
    expect((await callText(client, 'state', { action: 'dispatch', dispatch: { type: 'reset' } })).text).toBe(
      'Dispatched to the default store.',
    );
    expect(calls.map((call) => call.params)).toEqual([{ path: 'cart.items' }, { action: { type: 'reset' } }]);
    expect((await callText(client, 'state', { action: 'dispatch' })).text).toContain('INVALID_PARAMS');
  });

  it('says when no stores were found', async () => {
    const client = await connectedWith({
      'state.read': { data: { stores: [], value: undefined, truncated: false }, limitations: [] },
    });
    expect((await callText(client, 'state')).text).toBe('Stores: none found');
  });
});

describe('app tool', () => {
  it('shows info with windows, controls a window and clicks a menu item', async () => {
    const client = await connectedWith({
      'app.info': {
        data: {
          name: 'demo',
          version: '1.2.3',
          electron: '45.0.0',
          chrome: '140',
          node: '22',
          platform: 'linux',
          arch: 'x64',
          isPackaged: false,
          pid: 4242,
          windows: [
            window1,
            { ...window1, id: 2, target: undefined, visible: false, focused: false, minimized: true },
          ],
        },
        limitations: [],
      },
      'window.control': { data: { window: { ...window1, focused: false } }, limitations: [] },
      'menu.click': { data: { label: 'Open…' }, limitations: [] },
    });
    const info = (await callText(client, 'app', { action: 'info' })).text;
    expect(info).toContain(
      'demo 1.2.3 (pid 4242, development)\nElectron 45.0.0, Chrome 140, Node 22, linux-x64',
    );
    expect(info).toContain('window 1 target=wc1 "Main" 800×600 at 0,0 (focused)');
    expect(info).toContain('window 2 "Main" 800×600 at 0,0 (hidden, minimized)');
    const moved = await callText(client, 'app', {
      action: 'window',
      window: 1,
      windowAction: 'setBounds',
      bounds: { x: 5 },
    });
    expect(moved.text).toContain('Window 1: setBounds done.');
    expect((await callText(client, 'app', { action: 'menu', menuPath: ['File', 'Open…'] })).text).toBe(
      'Clicked menu item "Open…".',
    );
    await callText(client, 'app', { action: 'menu', menuId: 'open' });
    expect(calls.slice(1).map((call) => call.params)).toEqual([
      { window: 1, action: 'setBounds', bounds: { x: 5 } },
      { path: ['File', 'Open…'] },
      { id: 'open' },
    ]);
  });

  it('explains missing window and menu arguments, and a closed window', async () => {
    const client = await connectedWith({ 'window.control': { data: {}, limitations: [] } });
    expect((await callText(client, 'app', { action: 'window' })).text).toContain(
      'needs `window` and `windowAction`',
    );
    expect((await callText(client, 'app', { action: 'menu' })).text).toContain(
      'exactly one of menuId or menuPath',
    );
    expect((await callText(client, 'app', { action: 'window', window: 3, windowAction: 'close' })).text).toBe(
      'Window 3: close done.\nclosed',
    );
  });

  it('says when there are no windows', async () => {
    const info = {
      name: 'a',
      version: '1',
      electron: '45',
      chrome: '1',
      node: '1',
      platform: 'p',
      arch: 'a',
    };
    const client = await connectedWith({
      'app.info': { data: { ...info, isPackaged: true, pid: 1, windows: [] }, limitations: [] },
    });
    expect((await callText(client, 'app', { action: 'info' })).text).toContain('packaged)\n');
    expect((await callText(client, 'app', { action: 'info' })).text).toContain('No windows.');
  });
});

describe('eval and dialogs tools', () => {
  it('evaluate in main and queue dialog answers', async () => {
    const client = await connectedWith({
      'main.eval': { data: { type: 'object', value: { a: 1 }, truncated: true }, limitations: [] },
      'dialog.stub': { data: { queued: 2 }, limitations: [] },
    });
    expect((await callText(client, 'eval', { expression: 'process.versions', timeoutMs: 100 })).text).toBe(
      'Result (object):\n<untrusted-page-content>\n{\n  "a": 1\n}\n</untrusted-page-content>\n(value cut to fit)',
    );
    const stubbed = await callText(client, 'dialogs', {
      method: 'showOpenDialog',
      response: { canceled: true },
      times: 2,
    });
    expect(stubbed.text).toBe('2 showOpenDialog answer(s) queued.');
    expect(calls.map((call) => call.params)).toEqual([
      { expression: 'process.versions', timeoutMs: 100 },
      { method: 'showOpenDialog', response: { canceled: true }, times: 2 },
    ]);
  });

  it('show undefined results', async () => {
    const client = await connectedWith({
      'main.eval': { data: { type: 'undefined', truncated: false }, limitations: [] },
      'dialog.stub': { data: { queued: 1 }, limitations: [] },
    });
    expect((await callText(client, 'eval', { expression: 'void 0' })).text).toContain('undefined\n');
    expect((await callText(client, 'dialogs', { method: 'showMessageBox', response: {} })).isError).toBe(
      false,
    );
  });
});

describe('screenshot tool', () => {
  it('returns the image inline, or the path when the runtime saved it', async () => {
    let data: Record<string, unknown> = { mimeType: 'image/png', width: 10, height: 5, base64: 'iVBORw==' };
    const client = await connectedClient({
      ...api,
      connect: () =>
        Promise.resolve(
          fakeClient({
            'screenshot.take': {
              get data() {
                return data;
              },
              limitations: [],
            },
          }),
        ),
    });
    await callText(client, 'session', { action: 'connect' });
    const result = await client.callTool({ name: 'screenshot', arguments: { locator: { ref: 'e3' } } });
    expect(result.content).toEqual([
      { type: 'text', text: 'Screenshot 10×5 (image/png).' },
      { type: 'image', data: 'iVBORw==', mimeType: 'image/png' },
    ]);
    data = { mimeType: 'image/jpeg', width: 1, height: 1, path: '/tmp/s.jpg' };
    expect((await callText(client, 'screenshot', { format: 'jpeg' })).text).toBe(
      'Screenshot 1×1 (image/jpeg), saved to /tmp/s.jpg.',
    );
  });
});
