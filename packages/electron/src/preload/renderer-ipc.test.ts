import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { PRELOAD_SOURCE } from '../generated/preload-source.js';

interface Batch {
  instance: string;
  dropped: number;
  records: { rid?: number; channel: string; kind: string; phase: string; argShape: string }[];
}

/** Run the generated preload bundle against a fake `ipcRenderer`, as Electron would load it. */
function loadPreload() {
  const sent: [string, unknown[]][] = [];
  const timers: (() => void)[] = [];
  const ipcRenderer = {
    send: (channel: string, ...args: unknown[]) => {
      sent.push([channel, args]);
    },
    sendSync: (...args: unknown[]) => `sync:${String(args[0])}`,
    invoke: (...args: unknown[]) =>
      args[0] === 'fails' ? Promise.reject(new Error('no')) : Promise.resolve(42),
    postMessage: (channel: string, ...args: unknown[]) => {
      sent.push([channel, args]);
    },
  };
  const exposed: Record<string, unknown> = {};
  const contextBridge = {
    exposeInMainWorld(key: string, api: unknown) {
      exposed[key] = api;
    },
  };
  const module = { exports: {} };
  runInNewContext(PRELOAD_SOURCE, {
    module,
    exports: module.exports,
    require: (name: string) => {
      if (name !== 'electron') throw new Error(`preload required ${name}`);
      return { ipcRenderer, contextBridge };
    },
    setTimeout: (callback: () => void) => timers.push(callback),
    performance: { now: () => 0 },
    Promise,
    Math,
  });
  const flush = async (): Promise<Batch[]> => {
    await new Promise((resolve) => setImmediate(resolve));
    for (const timer of timers.splice(0)) timer();
    return sent.filter(([channel]) => channel === '__eab:uplink').map(([, [batch]]) => batch as Batch);
  };
  return { ipcRenderer, contextBridge, exposed, sent, flush };
}

describe('renderer preload', () => {
  it('records sends, sendSync with its result and invoke with its outcome, after the app’s own message', async () => {
    const { ipcRenderer, sent, flush } = loadPreload();
    ipcRenderer.send('log:write', 'line');
    expect(ipcRenderer.sendSync('sync:get', 1)).toBe('sync:sync:get');
    await expect(ipcRenderer.invoke('math:add', 2, 3)).resolves.toBe(42);
    await expect(ipcRenderer.invoke('fails')).rejects.toThrow('no');
    ipcRenderer.postMessage('port', { a: 1 });
    expect(sent[0]).toEqual(['log:write', ['line']]);
    const [batch] = await flush();
    expect(batch?.dropped).toBe(0);
    expect(
      batch?.records.map((record) => [record.channel, record.kind, record.phase, record.argShape]),
    ).toEqual([
      ['log:write', 'send', 'request', 'string[1]'],
      ['sync:get', 'sendSync', 'request', 'number[1]'],
      ['sync:get', 'sendSync', 'response', 'string[1]'],
      ['math:add', 'invoke', 'request', 'number[2]'],
      ['math:add', 'invoke', 'response', 'number[1]'],
      ['fails', 'invoke', 'request', '[]'],
      ['fails', 'invoke', 'error', 'error: no'],
      ['port', 'postMessage', 'request', '{a: number}[1]'],
    ]);
  });

  it('records calls into an API exposed through contextBridge, and keeps its results and errors', async () => {
    const { contextBridge, exposed, flush } = loadPreload();
    class Store {
      read(): number {
        return 1;
      }
    }
    const store = new Store();
    contextBridge.exposeInMainWorld('api', {
      version: '1.0',
      add: (a: number, b: number) => a + b,
      orders: { save: (order: { id: number }) => Promise.resolve({ ok: true, id: order.id }) },
      fail: () => {
        throw new Error('nope');
      },
      store,
    });
    const api = exposed['api'] as {
      version: string;
      add: (a: number, b: number) => number;
      orders: { save: (order: { id: number }) => Promise<{ ok: boolean }> };
      fail: () => void;
      store: Store;
    };
    expect(api.version).toBe('1.0');
    expect(api.store).toBe(store);
    expect(api.add(2, 3)).toBe(5);
    await expect(api.orders.save({ id: 7 })).resolves.toEqual({ ok: true, id: 7 });
    expect(() => {
      api.fail();
    }).toThrow('nope');
    const [batch] = await flush();
    expect(
      batch?.records.map((record) => [
        record.rid,
        record.channel,
        record.kind,
        record.phase,
        record.argShape,
      ]),
    ).toEqual([
      [1, 'bridge:api.add', 'bridgeCall', 'request', 'number[2]'],
      [1, 'bridge:api.add', 'bridgeCall', 'response', 'number[1]'],
      [2, 'bridge:api.orders.save', 'bridgeCall', 'request', '{id: number}[1]'],
      [2, 'bridge:api.orders.save', 'bridgeCall', 'response', '{ok: boolean, id: number}[1]'],
      [3, 'bridge:api.fail', 'bridgeCall', 'request', '[]'],
      [3, 'bridge:api.fail', 'bridgeCall', 'error', 'error: nope'],
    ]);
  });

  it('drops anything else sent on its uplink, so a page cannot forge records', async () => {
    const { ipcRenderer, sent, flush } = loadPreload();
    ipcRenderer.send('__eab:uplink', { instance: 'forged', dropped: 0, records: [] });
    ipcRenderer.postMessage('__eab:uplink', {});
    expect(sent).toEqual([]);
    expect(await flush()).toEqual([]);
  });

  it('counts what does not fit in a batch, and gives every load its own instance id', async () => {
    const first = loadPreload();
    for (let index = 0; index < 510; index++) first.ipcRenderer.send('burst', index);
    const [batch] = await first.flush();
    expect(batch?.records).toHaveLength(500);
    expect(batch?.dropped).toBe(10);
    const second = loadPreload();
    second.ipcRenderer.send('x');
    const [other] = await second.flush();
    expect(other?.instance).not.toBe(batch?.instance);
  });
});
