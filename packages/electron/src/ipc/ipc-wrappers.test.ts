import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { CorrelationQueue } from './correlation.js';
import { wrapIpcTarget, type IpcTarget, type WrapContext } from './ipc-main-wrapper.js';
import { IpcRecorder, UPLINK_CHANNEL } from './ipc-recorder.js';
import { SyncWaits } from './sync-waits.js';
import { createUplinkHandler } from './uplink.js';
import { hookWebContents } from './web-contents-hooks.js';

/** Enough of `ipcMain` to test the wrapper: an EventEmitter plus a handler table. */
class FakeIpcMain extends EventEmitter implements IpcTarget {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
  handle(channel: string, listener: (...args: unknown[]) => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`second handler for ${channel}`);
    this.handlers.set(channel, listener);
  }
  handleOnce(channel: string, listener: (...args: unknown[]) => unknown): void {
    this.handle(channel, (...args) => {
      this.handlers.delete(channel);
      return listener(...args);
    });
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  invoke(channel: string, event: object, ...args: unknown[]): unknown {
    return this.handlers.get(channel)?.call(this, event, ...args);
  }
}

const event = (frameId = 1) => ({ sender: { id: 3 }, frameId });

function setup() {
  const recorder = new IpcRecorder();
  const context: WrapContext = {
    recorder,
    correlation: new CorrelationQueue(),
    seen: new WeakSet(),
    syncEvents: new WeakSet(),
    proxies: new WeakMap(),
    wrapped: new WeakSet(),
    recording: { value: true },
  };
  const ipc = new FakeIpcMain();
  const undo = wrapIpcTarget(ipc, context);
  const events = () => recorder.query({ limit: 500 }).items;
  return { recorder, context, ipc, undo, events };
}

describe('wrapIpcTarget', () => {
  it('records invoke request and response with one id and returns the app’s own result', async () => {
    const { ipc, events } = setup();
    const promise = Promise.resolve(5);
    ipc.handle('math:add', function add(this: unknown) {
      expect(this).toBe(ipc);
      return promise;
    });
    expect(ipc.invoke('math:add', event(), 2, 3)).toBe(promise);
    await promise;
    await Promise.resolve();
    const [request, response] = events();
    expect(request).toMatchObject({
      kind: 'invoke',
      phase: 'request',
      side: 'main',
      argShape: 'number[2]',
      sender: { target: 'wc3', frameId: 1 },
    });
    expect(response).toMatchObject({
      kind: 'handle',
      phase: 'response',
      corr: request?.corr,
      argShape: 'number[1]',
    });
  });

  it('records synchronous results, throws and rejections, and rethrows unchanged', async () => {
    const { ipc, events } = setup();
    const failure = new Error('boom');
    ipc.handle('sync', () => 'value');
    ipc.handle('throws', () => {
      throw failure;
    });
    ipc.handleOnce('rejects', () => Promise.reject(new Error('nope')));
    expect(ipc.invoke('sync', event())).toBe('value');
    expect(() => ipc.invoke('throws', event())).toThrow(failure);
    await expect(ipc.invoke('rejects', event())).rejects.toThrow('nope');
    expect(ipc.handlers.has('rejects')).toBe(false);
    expect(
      events()
        .filter((record) => record.phase !== 'request')
        .map((record) => record.argShape),
    ).toEqual(['string[1]', 'error: boom', 'error: nope']);
  });

  it('records each message once however many listeners it reaches, and removal finds the wrapper', () => {
    const { ipc, events } = setup();
    const calls: string[] = [];
    const first = (_event: unknown, line: unknown) => calls.push(`first ${String(line)}`);
    ipc.on('log', first);
    ipc.addListener('log', () => calls.push('second'));
    ipc.once('once', () => calls.push('once'));
    const message = event();
    ipc.emit('log', message, 'a');
    ipc.emit('once', event());
    ipc.emit('once', event());
    expect(ipc.removeListener('log', first)).toBe(ipc);
    ipc.off('log', first);
    ipc.emit('log', event(), 'b');
    expect(calls).toEqual(['first a', 'second', 'once', 'second']);
    expect(events().map((record) => [record.channel, record.kind])).toEqual([
      ['log', 'send'],
      ['once', 'send'],
      ['log', 'send'],
    ]);
  });

  it('marks sendSync messages and observes the returned value where Electron allows it', () => {
    const { ipc, context, events } = setup();
    ipc.on('sync:get', (syncEvent: { returnValue?: unknown }) => {
      syncEvent.returnValue = 42;
    });
    let delivered: unknown;
    const sync = event();
    Object.defineProperty(sync, 'returnValue', {
      configurable: true,
      set(value: unknown) {
        delivered = value;
      },
    });
    ipc.emit('sync:get', sync);
    const marked = event();
    context.syncEvents.add(marked);
    ipc.emit('sync:get', marked);
    expect(delivered).toBe(42);
    expect(events().map((record) => [record.kind, record.phase, record.argShape])).toEqual([
      ['sendSync', 'request', '[]'],
      ['sendSync', 'response', 'number[1]'],
      ['sendSync', 'request', '[]'],
    ]);
  });

  it('records the sendSync value an Electron ≤ 42 fixed setter sends through the reply channel', () => {
    const { ipc, events } = setup();
    const replies: unknown[] = [];
    const sync = { ...event(), _replyChannel: { sendReply: (value: unknown) => replies.push(value) } };
    Object.defineProperty(sync, 'returnValue', {
      configurable: false,
      get: () => undefined,
      set: (value: unknown) => sync._replyChannel.sendReply(value),
    });
    let received: unknown;
    ipc.on('sync:get', (syncEvent: object) => {
      received = syncEvent;
      (syncEvent as { returnValue?: unknown }).returnValue = { ok: true };
    });
    ipc.emit('sync:get', sync);
    expect(received).toBe(sync);
    expect(replies).toEqual([{ ok: true }]);
    expect(events().map((record) => [record.phase, record.argShape])).toEqual([
      ['request', '[]'],
      ['response', '{ok: boolean}[1]'],
    ]);
  });

  it('gives an Electron 45 sendSync event’s listeners one proxy that sees the value and forwards it', () => {
    const { ipc, events } = setup();
    // Native methods throw unless called on the event itself, like Electron's.
    class NativeEvent {
      readonly #prevented = { value: false };
      readonly sender = { id: 3 };
      readonly frameId = 1;
      returnValue: unknown = undefined;
      preventDefault(): void {
        this.#prevented.value = true;
      }
      get defaultPrevented(): boolean {
        return this.#prevented.value;
      }
    }
    const sync = new NativeEvent();
    const seen: object[] = [];
    ipc.on('sync:get', (syncEvent: NativeEvent) => {
      seen.push(syncEvent);
      syncEvent.preventDefault();
      expect(syncEvent.defaultPrevented).toBe(true);
      expect(syncEvent).toBeInstanceOf(NativeEvent);
    });
    ipc.on('sync:get', (syncEvent: NativeEvent) => {
      seen.push(syncEvent);
      syncEvent.returnValue = 'v';
    });
    ipc.emit('sync:get', sync);
    expect(seen[0]).toBe(seen[1]);
    expect(sync.returnValue).toBe('v');
    expect(events().map((record) => [record.kind, record.phase])).toEqual([
      ['sendSync', 'request'],
      ['sendSync', 'response'],
    ]);
  });

  it('tracks a sendSync as a wait of its page until a listener sets the value, even later', () => {
    const { context } = setup();
    const waits = new SyncWaits(() => 100);
    const tracked: WrapContext = { ...context, waits, wrapped: new WeakSet() };
    const target = new FakeIpcMain();
    wrapIpcTarget(target, tracked);
    let answer: ((value: unknown) => void) | undefined;
    target.on('dialog:confirm', (syncEvent: { returnValue?: unknown }) => {
      // The app answers once its dialog closes.
      answer = (value) => {
        syncEvent.returnValue = value;
      };
    });
    const sync = event();
    Object.defineProperty(sync, 'returnValue', { configurable: true, set: () => undefined });
    target.emit('dialog:confirm', sync);
    expect(waits.oldest('wc3')).toEqual({ channel: 'dialog:confirm', since: 100, openedBefore: 0 });
    answer?.(1);
    expect(waits.oldest('wc3')).toBeUndefined();
    // A value Electron gives no way to observe would never end the wait: not tracked.
    const unobservable = event();
    Object.defineProperty(unobservable, 'returnValue', { configurable: false, set: () => undefined });
    target.emit('dialog:confirm', unobservable);
    expect(waits.oldest('wc3')).toBeUndefined();
  });

  it('wraps a target once, and after undo or stop keeps the app’s listeners removable', () => {
    const { ipc, undo, context, events } = setup();
    expect(wrapIpcTarget(ipc, context)).toBeTypeOf('function');
    const calls: string[] = [];
    const early = () => calls.push('early');
    ipc.on('ch', early);
    ipc.emit('ch', event());
    expect(events()).toHaveLength(1);
    undo();
    const late = () => calls.push('late');
    ipc.on('ch', late);
    // Registered after the undo: the app's own function, not a wrapper.
    expect(ipc.listeners('ch').at(-1)).toBe(late);
    ipc.removeListener('ch', early);
    context.recording.value = false;
    ipc.emit('ch', event());
    expect(calls).toEqual(['early', 'late']);
    expect(events()).toHaveLength(1);
  });
});

describe('uplink', () => {
  it('pairs renderer requests with main ones, keeps response ids, and validates every record', () => {
    const recorder = new IpcRecorder();
    const correlation = new CorrelationQueue();
    correlation.push('3:1:math:add', 'c-main');
    const handle = createUplinkHandler({ recorder, correlation });
    const sender = { id: 3, getLastWebPreferences: () => ({ contextIsolation: true }) };
    const batch = (records: unknown[], dropped = 0) => ({ instance: 'i1', dropped, records });
    handle(
      { sender, frameId: 1 },
      batch([
        { rid: 1, channel: 'math:add', kind: 'invoke', phase: 'request', argShape: 'number[2]' },
        { rid: 1, channel: 'math:add', kind: 'invoke', phase: 'response', argShape: 'number[1]', durMs: 2 },
        { rid: 2, channel: 'no:handler', kind: 'invoke', phase: 'request', argShape: '[]' },
        { channel: UPLINK_CHANNEL, kind: 'send', phase: 'request' },
        { channel: 'bad', kind: 'explode', phase: 'request' },
        { channel: 'x'.repeat(300), kind: 'send', phase: 'request' },
        { rid: 9, channel: 'orphan', kind: 'invoke', phase: 'error', argShape: 'error: x', durMs: -1 },
        'nonsense',
      ]),
    );
    handle(
      { sender: { id: 4, getLastWebPreferences: () => ({ contextIsolation: false }) } },
      batch([{ channel: 'spoofable', kind: 'send', phase: 'request' }]),
    );
    handle({ sender }, 'not a batch');
    handle({ sender }, [{ channel: 'old-format', kind: 'send', phase: 'request' }]);
    handle({ sender }, { instance: 'x'.repeat(40), dropped: 0, records: [] });
    const items = recorder.query().items;
    expect(
      items.map((record) => [record.channel, record.phase, record.corr === 'c-main', record.correlation]),
    ).toEqual([
      ['math:add', 'request', true, 'exact'],
      ['math:add', 'response', true, 'exact'],
      ['no:handler', 'request', false, 'heuristic'],
      ['orphan', 'error', false, 'heuristic'],
      ['spoofable', 'request', false, 'heuristic'],
    ]);
    expect(items[1]?.durMs).toBe(2);
    expect(items[3]?.durMs).toBeUndefined();
    expect(items[4]).toMatchObject({ trust: 'low', argShape: '?' });
  });

  it('keys responses by frame and preload instance, and forgets a frame’s ids after drops', () => {
    const recorder = new IpcRecorder();
    const correlation = new CorrelationQueue();
    const handle = createUplinkHandler({ recorder, correlation });
    const sender = { id: 3 };
    const request = { rid: 1, channel: 'a', kind: 'invoke', phase: 'request', argShape: '[]' };
    const response = { rid: 1, channel: 'a', kind: 'invoke', phase: 'response', argShape: '[]' };
    // Two frames (and a reload) all count their request ids from 1.
    handle({ sender, frameId: 1 }, { instance: 'main', dropped: 0, records: [request] });
    handle({ sender, frameId: 2 }, { instance: 'sub', dropped: 0, records: [request] });
    handle({ sender, frameId: 1 }, { instance: 'main', dropped: 0, records: [response] });
    handle({ sender, frameId: 2 }, { instance: 'sub', dropped: 0, records: [response] });
    const [first, second, firstReply, secondReply] = recorder.query().items;
    expect(firstReply?.corr).toBe(first?.corr);
    expect(secondReply?.corr).toBe(second?.corr);
    expect(first?.corr).not.toBe(second?.corr);
    correlation.push('3:1:b', 'c-stale');
    correlation.push('3:2:b', 'c-other-frame');
    handle({ sender, frameId: 1 }, { instance: 'main', dropped: 4, records: [] });
    expect(correlation.take('3:1:b')).toBeUndefined();
    expect(correlation.take('3:2:b')).toBe('c-other-frame');
  });
});

describe('uplink bridge calls', () => {
  it('records contextBridge calls as exact pairs, without taking a main-side request id', () => {
    const recorder = new IpcRecorder();
    const correlation = new CorrelationQueue();
    correlation.push('3:1:bridge:api.save', 'c-main');
    const handle = createUplinkHandler({ recorder, correlation });
    const records = [
      {
        rid: 1,
        channel: 'bridge:api.save',
        kind: 'bridgeCall',
        phase: 'request',
        argShape: '{id: number}[1]',
      },
      {
        rid: 1,
        channel: 'bridge:api.save',
        kind: 'bridgeCall',
        phase: 'response',
        argShape: 'boolean[1]',
        durMs: 1,
      },
    ];
    handle({ sender: { id: 3 }, frameId: 1 }, { instance: 'i', dropped: 0, records });
    const [request, response] = recorder.query().items;
    expect([request?.kind, request?.correlation, response?.correlation]).toEqual([
      'bridgeCall',
      'exact',
      'exact',
    ]);
    expect(response?.corr).toBe(request?.corr);
    expect(correlation.take('3:1:bridge:api.save')).toBe('c-main');
  });
});

describe('hookWebContents', () => {
  it('wraps the page’s own ipc and frames, records outbound messages, and falls back to documented events', async () => {
    const recorder = new IpcRecorder();
    const delivered: unknown[][] = [];
    const contents = Object.assign(new EventEmitter(), {
      id: 7,
      ipc: new FakeIpcMain(),
      mainFrame: { ipc: new FakeIpcMain() },
      send: (...args: unknown[]) => (delivered.push(['send', ...args]), 'sent'),
      postMessage: (...args: unknown[]) => (delivered.push(['postMessage', ...args]), 'posted'),
      sendToFrame: (...args: unknown[]) => (delivered.push(['sendToFrame', ...args]), 'framed'),
    });
    const context: WrapContext = {
      recorder,
      correlation: new CorrelationQueue(),
      seen: new WeakSet(),
      syncEvents: new WeakSet(),
      proxies: new WeakMap(),
      wrapped: new WeakSet(),
      recording: { value: true },
    };
    const undo = hookWebContents(contents as never, context);
    contents.ipc.handle('page:only', () => 'scoped');
    contents.ipc.invoke('page:only', event());
    const frameIpc = new FakeIpcMain();
    contents.emit('frame-created', {}, { frame: { ipc: frameIpc } });
    // Electron reports the main frame through frame-created too: it must not be wrapped twice.
    contents.emit('frame-created', {}, { frame: contents.mainFrame });
    contents.mainFrame.ipc.handle('frame:handle', () => 'once');
    contents.mainFrame.ipc.invoke('frame:handle', event());
    frameIpc.on('frame:msg', () => undefined);
    frameIpc.emit('frame:msg', event(5));
    expect(contents.send('push', 1)).toBe('sent');
    expect(contents.postMessage('port', { a: 1 })).toBe('posted');
    expect(contents.sendToFrame([1, 9], 'framed', 'x')).toBe('framed');
    contents.emit('ipc-message', { frameId: 1 }, 'unlistened', 'arg');
    const syncEvent = { frameId: 1 };
    contents.emit('ipc-message-sync', syncEvent, 'unlistened-sync');
    // A wrapped listener records the message in the same emit: the fallback then stays quiet.
    const heard = { ...event(), frameId: 1 };
    contents.emit('ipc-message', heard, 'listened');
    frameIpc.on('listened', () => undefined);
    frameIpc.emit('listened', heard);
    await Promise.resolve();
    expect(context.syncEvents.has(syncEvent)).toBe(true);
    expect(delivered).toEqual([
      ['send', 'push', 1],
      ['postMessage', 'port', { a: 1 }],
      ['sendToFrame', [1, 9], 'framed', 'x'],
    ]);
    expect(
      recorder
        .query({ limit: 50 })
        .items.map((record) => [record.channel, record.kind, record.correlation, record.sender?.frameId]),
    ).toEqual([
      ['page:only', 'invoke', 'exact', 1],
      ['page:only', 'handle', 'exact', 1],
      ['frame:handle', 'invoke', 'exact', 1],
      ['frame:handle', 'handle', 'exact', 1],
      ['frame:msg', 'send', 'exact', 5],
      ['push', 'toRenderer', 'exact', undefined],
      ['port', 'toRenderer', 'exact', undefined],
      ['framed', 'toRenderer', 'exact', 9],
      ['listened', 'send', 'exact', 1],
      ['unlistened', 'send', 'heuristic', 1],
      ['unlistened-sync', 'sendSync', 'heuristic', 1],
    ]);
    // A page that goes away waits on nothing any more.
    const waits = new SyncWaits();
    const page = Object.assign(new EventEmitter(), { id: 8, send: () => undefined });
    const unhook = hookWebContents(page as never, { ...context, waits, wrapped: new WeakSet() });
    waits.begin('wc8', 'confirm');
    waits.begin('wc7', 'other');
    page.emit('destroyed');
    expect(waits.oldest('wc8')).toBeUndefined();
    expect(waits.oldest('wc7')?.channel).toBe('other');
    unhook();
    expect(page.listenerCount('destroyed')).toBe(0);
    undo();
    expect(contents.listenerCount('ipc-message')).toBe(0);
    expect(contents.listenerCount('frame-created')).toBe(0);
    contents.send('after');
    expect(recorder.query({ channel: 'after' }).items).toEqual([]);
  });
});
