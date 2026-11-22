import { describe, expect, it } from 'vitest';

import { attach, withStoreHint } from './attach.js';
import { MAX_PAGES, RemoteTargetSource } from './remote-targets.js';
import { WebSocketCdpTransport, type SocketLike } from './websocket-transport.js';

/** A scripted DevTools socket: answers commands with `answers[method]`, records what was sent. */
class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: { id: number; method: string; sessionId?: string }[] = [];
  readonly #listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  constructor(
    readonly url: string,
    readonly answers: Record<string, unknown> = {},
    readonly opens = true,
  ) {
    queueMicrotask(() => {
      if (this.opens) {
        this.readyState = 1;
        this.#fire('open', { data: undefined });
      } else this.#fire('error', { data: undefined });
    });
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    const message = JSON.parse(data) as { id: number; method: string; sessionId?: string };
    this.sent.push(message);
    const answer = this.answers[message.method];
    queueMicrotask(() => {
      this.message(
        answer instanceof Error
          ? { id: message.id, error: { message: answer.message } }
          : { id: message.id, result: answer ?? {} },
      );
    });
  }

  close(): void {
    this.readyState = 3;
    this.#fire('close', { data: undefined });
  }

  message(payload: unknown): void {
    this.#fire('message', { data: JSON.stringify(payload) });
  }

  #fire(type: string, event: { data: unknown }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

const json = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

describe('WebSocketCdpTransport', () => {
  it('sends commands with ids, resolves their results, delivers events and fails on close', async () => {
    let socket: FakeSocket | undefined;
    const transport = await WebSocketCdpTransport.open(
      'ws://x/devtools/page/1',
      (url) =>
        (socket = new FakeSocket(url, { 'Runtime.evaluate': { result: 1 }, 'Bad.cmd': new Error('nope') })),
    );
    await expect(transport.send('Runtime.evaluate', { expression: '1' })).resolves.toEqual({ result: 1 });
    await expect(transport.send('Bad.cmd')).rejects.toMatchObject({ code: 'INTERNAL', message: 'nope' });
    transport.post('Runtime.enable', {}, 'child');
    expect(socket?.sent.at(-1)).toMatchObject({ method: 'Runtime.enable', sessionId: 'child' });
    const events: unknown[] = [];
    transport.onEvent((event) => events.push(event));
    socket?.message({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 's' });
    socket?.message('not json');
    expect(events).toEqual([{ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 's' }]);
    const reasons: string[] = [];
    transport.onDetach((reason) => reasons.push(reason));
    socket?.close();
    expect(reasons).toEqual(['target-closed']);
    expect(transport.attached).toBe(false);
    await expect(transport.send('Runtime.evaluate')).rejects.toMatchObject({ code: 'DETACHED' });
    transport.onAttach().dispose();
    await transport.close();
  });

  it('rejects when the socket cannot be opened', async () => {
    await expect(
      WebSocketCdpTransport.open('ws://x', (url) => new FakeSocket(url, {}, false)),
    ).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' });
  });
});

describe('RemoteTargetSource', () => {
  it('follows pages and webviews of /json/list, leaving DevTools and others out', async () => {
    let list: unknown[] = [
      { id: 'A', type: 'page', title: 'Main', url: 'file:///main.html', webSocketDebuggerUrl: 'ws://x/A' },
      { id: 'B', type: 'webview', title: 'Guest', url: 'https://guest/', webSocketDebuggerUrl: 'ws://x/B' },
      {
        id: 'C',
        type: 'page',
        title: 'DevTools',
        url: 'devtools://devtools/x',
        webSocketDebuggerUrl: 'ws://x/C',
      },
      {
        id: 'D',
        type: 'service_worker',
        title: 'sw',
        url: 'https://x/sw.js',
        webSocketDebuggerUrl: 'ws://x/D',
      },
    ];
    const watched: string[] = [];
    const source = new RemoteTargetSource({
      base: 'http://127.0.0.1:9',
      fetch: () => json(list),
      socket: (url) => new FakeSocket(url),
      onPage: (id) => {
        watched.push(id);
        return { dispose: () => undefined };
      },
    });
    await source.refresh();
    expect(source.list().map(({ id, kind, focused }) => [id, kind, focused])).toEqual([
      ['A', 'window', true],
      ['B', 'webview', false],
    ]);
    expect(watched).toEqual(['A', 'B']);
    list = [
      { id: 'A', type: 'page', title: 'Renamed', url: 'file:///main.html', webSocketDebuggerUrl: 'ws://x/A' },
    ];
    await source.refresh();
    expect(source.list().map(({ id, title }) => [id, title])).toEqual([['A', 'Renamed']]);
    source.stop();
    expect(source.list()).toEqual([]);
  });
});

describe('RemoteTargetSource limits', () => {
  it('opens at most MAX_PAGES sockets in one refresh, and closes sockets that open after stop', async () => {
    const list = Array.from({ length: MAX_PAGES + 10 }, (_, index) => ({
      id: `P${index}`,
      type: 'page',
      title: '',
      url: `file:///${index}.html`,
      webSocketDebuggerUrl: `ws://x/${index}`,
    }));
    const sockets: FakeSocket[] = [];
    const source = new RemoteTargetSource({
      base: 'http://127.0.0.1:9',
      fetch: () => json(list),
      socket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    await source.refresh();
    expect(sockets).toHaveLength(MAX_PAGES);
    const late = new RemoteTargetSource({
      base: 'http://127.0.0.1:9',
      fetch: () => json(list.slice(0, 1)),
      socket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const refreshing = late.refresh();
    late.stop();
    await refreshing;
    expect(late.list()).toEqual([]);
    expect(sockets.at(-1)?.readyState).toBe(3);
    source.stop();
  });
});

describe('attach', () => {
  const fetchFor = (pages: unknown[]) => (url: string) =>
    url.endsWith('/json/version')
      ? json({
          Browser: 'Chrome/140',
          'User-Agent':
            'Mozilla/5.0 (X11) AppleWebKit/537.36 (KHTML, like Gecko) Orders/2.4.1 Chrome/140 Electron/45.0.0 Safari/537.36',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/b1',
        })
      : json(pages);
  /** The browser target says which process is the main one; pages answer nothing in particular. */
  const sockets = (url: string): FakeSocket =>
    new FakeSocket(
      url,
      url.includes('/devtools/browser/')
        ? {
            'SystemInfo.getProcessInfo': {
              processInfo: [
                { type: 'renderer', id: 41 },
                { type: 'browser', id: 40 },
              ],
            },
          }
        : {},
    );

  it('serves renderer methods in this process and refuses main-process ones', async () => {
    const client = await attach({ port: 9333, fetch: fetchFor([]), socket: sockets });
    expect(client.session).toMatchObject({
      mode: 'attach',
      features: ['pages', 'state'],
      app: { name: 'Orders', version: '2.4.1', electron: '45.0.0', pid: 40 },
    });
    expect(client.handshake.pid).toBe(40);
    expect((await client.call('targets.list', {})).data.targets).toEqual([]);
    await expect(client.call('ipc.query', {})).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      hint: expect.stringContaining('Integrated or Launch') as unknown,
    });
    await expect(client.call('snapshot.take', { depth: 0 })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect((await client.call('record.start', {})).data.recording).toBe(true);
    expect((await client.call('record.events', {})).data.items).toEqual([]);
    expect((await client.call('record.stop', {})).data.recording).toBe(false);
    expect((await client.call('session.reset', {})).data.reset).toBe(true);
    expect((await client.call('logs.query', {})).data.items).toEqual([]);
    client.close();
    expect(client.closed).toBe(true);
    await expect(client.call('targets.list', {})).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' });
  });

  it('says how to open the port when nothing answers', async () => {
    await expect(
      attach({ port: 1, fetch: () => Promise.reject(new Error('ECONNREFUSED')) }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      hint: expect.stringContaining('--remote-debugging-port') as unknown,
    });
  });

  it('falls back to a generic name and pid 0 when the endpoint tells neither', async () => {
    const plain = (url: string) =>
      url.endsWith('/json/version') ? json({ 'User-Agent': 'Mozilla/5.0 Electron/45.0.0' }) : json([]);
    const client = await attach({ port: 9334, fetch: plain, socket: (url) => new FakeSocket(url) });
    expect(client.session.app).toEqual({ name: 'electron-app', version: '', electron: '45.0.0', pid: 0 });
    client.close();
  });

  it('explains an empty store list: stores made before attaching show after a reload', () => {
    const empty = withStoreHint({ data: { stores: [] }, limitations: [] });
    expect(empty.limitations).toEqual([
      expect.objectContaining({ code: 'degraded', message: expect.stringContaining('reloads') as unknown }),
    ]);
    const found = { data: { stores: [{ name: 'main' }] }, limitations: [] };
    expect(withStoreHint(found)).toBe(found);
  });
});
