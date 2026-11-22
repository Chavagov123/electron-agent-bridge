import { describe, expect, it } from 'vitest';

import { CorrelationQueue } from './correlation.js';
import { queryIpc } from './ipc-query.js';
import { IpcRecorder, SCHEMA_SAMPLES, UPLINK_CHANNEL } from './ipc-recorder.js';

const request = { kind: 'send', phase: 'request', side: 'main' } as const;

describe('IpcRecorder', () => {
  it('records shapes, never values unless the channel is opted in, and redacts secrets', () => {
    const recorder = new IpcRecorder({ valueChannels: ['settings:*'], now: () => 7 });
    recorder.record({ ...request, channel: 'orders:save', payload: [{ id: 1, password: 'x' }] });
    recorder.record({ ...request, channel: 'settings:save', payload: [{ theme: 'dark', token: 'y' }] });
    const [orders, settings] = recorder.query().items;
    expect(orders).toMatchObject({
      seq: 1,
      ts: 7,
      argShape: '{id: number, password: string}[1]',
      correlation: 'exact',
      trust: 'high',
    });
    expect(orders?.values).toBeUndefined();
    expect(settings?.values).toEqual([{ theme: 'dark', token: '[redacted]' }]);
  });

  it('infers each channel’s request and response types from main-side payloads, on request', () => {
    const recorder = new IpcRecorder();
    recorder.record({
      channel: 'orders:save',
      kind: 'invoke',
      phase: 'request',
      side: 'main',
      payload: [{ id: 1, note: 'a' }],
    });
    recorder.record({
      channel: 'orders:save',
      kind: 'invoke',
      phase: 'request',
      side: 'main',
      payload: [{ id: 2 }, true],
    });
    recorder.record({
      channel: 'orders:save',
      kind: 'handle',
      phase: 'response',
      side: 'main',
      payload: [{ ok: true }],
    });
    recorder.record({ channel: 'orders:save', kind: 'handle', phase: 'error', side: 'main', error: 'boom' });
    recorder.record({
      channel: 'orders:save',
      kind: 'invoke',
      phase: 'request',
      side: 'renderer',
      argShape: 'x',
    });
    expect(recorder.query().channels[0]).not.toHaveProperty('schema');
    expect(recorder.query({ schemas: true }).channels[0]).toEqual({
      channel: 'orders:save',
      kinds: ['handle', 'invoke'],
      count: 5,
      schema: {
        request: '(a: {id: number, note?: string}, b?: boolean)',
        response: '{ok: boolean}',
        samples: 2,
      },
    });
  });

  it('stops merging a channel’s types after SCHEMA_SAMPLES messages', () => {
    const recorder = new IpcRecorder();
    for (let index = 0; index < SCHEMA_SAMPLES; index++) {
      recorder.record({ channel: 'tick', kind: 'send', phase: 'request', side: 'main', payload: [index] });
    }
    recorder.record({ channel: 'tick', kind: 'send', phase: 'request', side: 'main', payload: ['late'] });
    expect(recorder.query({ schemas: true }).channels[0]?.schema).toEqual({
      request: '(a: number)',
      samples: SCHEMA_SAMPLES,
    });
  });

  it('never records its own uplink and tags Electron or pre-existing channels as internal', () => {
    const recorder = new IpcRecorder();
    recorder.markPreexisting(['lib:early']);
    expect(recorder.record({ ...request, channel: UPLINK_CHANNEL })).toBeUndefined();
    recorder.record({ ...request, channel: 'ELECTRON_BROWSER_WINDOW' });
    recorder.record({ ...request, channel: 'lib:early' });
    recorder.record({ ...request, channel: 'app:mine' });
    expect(recorder.query().items.map((event) => event.channel)).toEqual(['app:mine']);
    expect(
      recorder.query({ includeInternal: true }).items.map((event) => [event.channel, event.internal]),
    ).toEqual([
      ['ELECTRON_BROWSER_WINDOW', true],
      ['lib:early', true],
      ['app:mine', undefined],
    ]);
    expect(recorder.query().channels.map((entry) => entry.channel)).toEqual(['app:mine']);
  });

  it('filters by channel glob and kind, pages past skipped events, and feeds actions and waits', () => {
    const recorder = new IpcRecorder();
    for (let index = 0; index < 5; index++) {
      recorder.record({ ...request, channel: index % 2 === 0 ? 'a:even' : 'b:odd' });
    }
    recorder.record({ channel: 'a:even', kind: 'invoke', phase: 'request', side: 'main', error: 'boom' });
    const first = recorder.query({ channel: 'a:*', limit: 2 });
    expect(first.items.map((event) => event.seq)).toEqual([1, 3]);
    expect(first).toMatchObject({ nextSeq: 3, more: true, dropped: 0 });
    const rest = recorder.query({ channel: 'a:*', since: first.nextSeq });
    expect(rest.items.map((event) => event.seq)).toEqual([5, 6]);
    expect(rest.items[1]?.argShape).toBe('error: boom');
    expect(recorder.query({ kind: 'invoke' }).items).toHaveLength(1);
    expect(recorder.query({ channel: 'b:*' }).channels).toEqual([
      { channel: 'b:odd', kinds: ['send'], count: 2 },
    ]);
    expect(recorder.since(4, 10)).toEqual({
      items: [
        { seq: 5, channel: 'a:even', kind: 'send' },
        { seq: 6, channel: 'a:even', kind: 'invoke' },
      ],
      nextSeq: 6,
    });
    expect(recorder.lastSeq()).toBe(6);
  });

  it('reports evicted messages and an overflowing catalogue as limitations', () => {
    const recorder = new IpcRecorder({ capacityBytes: 2_000 });
    for (let index = 0; index < 2_100; index++) recorder.record({ ...request, channel: `c${index}` });
    const result = queryIpc(recorder, { limit: 10 });
    expect(result.data.dropped).toBeGreaterThan(0);
    expect(result.limitations.map((limitation) => limitation.code)).toEqual(['dropped', 'truncated']);
    expect(result.data.channels).toHaveLength(2_000);
    expect(
      queryIpc(recorder, { since: recorder.lastSeq(), channel: 'c1', kind: 'send', includeInternal: false })
        .data.items,
    ).toEqual([]);
  });
});

describe('CorrelationQueue', () => {
  it('pairs first in, first out per key, forgets a key that overflows, and clears by prefix', () => {
    const queue = new CorrelationQueue();
    queue.push('k', 'c1');
    queue.push('k', 'c2');
    expect([queue.take('k'), queue.take('k'), queue.take('k')]).toEqual(['c1', 'c2', undefined]);
    // The renderer fell far behind: better no pairing than a wrong one.
    for (let index = 0; index < 513; index++) queue.push('busy', `c${index}`);
    expect(queue.take('busy')).toBeUndefined();
    queue.push('3:1:a', 'x');
    queue.push('3:2:a', 'y');
    queue.clearPrefix('3:1:');
    expect([queue.take('3:1:a'), queue.take('3:2:a')]).toEqual([undefined, 'y']);
    for (let index = 0; index < 1_001; index++) queue.push(`key${index}`, 'x');
    expect(queue.take('key0')).toBeUndefined();
    expect(queue.take('key1000')).toBe('x');
  });
});
