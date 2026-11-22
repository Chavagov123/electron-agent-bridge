import { afterEach, describe, expect, it } from 'vitest';

import { api, callText, calls, closeClient, connectedClient, fakeClient } from '../testing/mcp-harness.js';

afterEach(closeClient);

async function connectedWith(overrides: Record<string, unknown>) {
  const client = await connectedClient({ ...api, connect: () => Promise.resolve(fakeClient(overrides)) });
  await callText(client, 'session', { action: 'connect' });
  calls.length = 0;
  return client;
}

const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  data: { items, nextSeq: 7, dropped: 0, more: false, ...extra },
  limitations: [],
});

describe('logs tool', () => {
  it('renders entries untrusted, continues with newOnly per filter set, and reports evictions', async () => {
    const client = await connectedWith({
      'logs.query': page(
        [
          {
            seq: 6,
            ts: 0,
            source: 'renderer',
            level: 'error',
            text: 'boom',
            target: 'main',
            url: 'file:///app.js',
            line: 3,
            stack: 'at a\nat b',
          },
          { seq: 7, ts: 0, source: 'main', level: 'info', text: 'ready' },
        ],
        { dropped: 2, more: true },
      ),
    });
    const first = await callText(client, 'logs', { minLevel: 'info' });
    expect(first.text).toBe(
      [
        '2 entr(ies)',
        '<untrusted-page-content>',
        '#6 error renderer [main]: boom (file:///app.js:3)',
        '    at a',
        '    at b',
        '#7 info main: ready',
        '</untrusted-page-content>',
        'next seq: 7; more records are waiting: call again with newOnly or since; ' +
          '2 older record(s) were evicted before they were read',
      ].join('\n'),
    );
    await callText(client, 'logs', { minLevel: 'info', newOnly: true });
    await callText(client, 'logs', { newOnly: true, contains: 'x' });
    await callText(client, 'logs', { since: 3, limit: 5 });
    expect(calls.map((call) => call.params)).toEqual([
      { minLevel: 'info', limit: 100 },
      { minLevel: 'info', since: 7, limit: 100 },
      { contains: 'x', limit: 100 },
      { since: 3, limit: 5 },
    ]);
  });

  it('says when there is nothing', async () => {
    const client = await connectedWith({ 'logs.query': page([]) });
    expect((await callText(client, 'logs')).text).toBe('No log entries.\nnext seq: 7');
  });
});

describe('network tool', () => {
  it('renders outcome, type, timing, size and cache', async () => {
    const client = await connectedWith({
      'network.query': page([
        {
          seq: 1,
          ts: 0,
          target: 'main',
          requestId: 'r1',
          method: 'GET',
          url: 'https://api/x',
          resourceType: 'Fetch',
          status: 500,
          durMs: 12.4,
          encodedBytes: 40,
          fromCache: true,
        },
        {
          seq: 2,
          ts: 0,
          target: 'main',
          requestId: 'r2',
          method: 'POST',
          url: 'u',
          failed: 'net::ERR_FAILED',
        },
        { seq: 3, ts: 0, target: 'main', requestId: 'r3', method: 'GET', url: 'v' },
      ]),
    });
    const { text } = await callText(client, 'network', { failedOnly: true, url: '*api*' });
    expect(calls[0]?.params).toEqual({ failedOnly: true, url: '*api*', limit: 100 });
    expect(text).toContain('#1 [main] GET https://api/x → 500 (Fetch, 12 ms, 40 B, cache)');
    expect(text).toContain('#2 [main] POST u → net::ERR_FAILED');
    expect(text).toContain('#3 [main] GET v → pending');
  });

  it('cuts long URLs (tracking payloads) and refuses unknown fields', async () => {
    const long = `https://t.example/a?d=${'x'.repeat(400)}`;
    const client = await connectedWith({
      'network.query': page([{ seq: 1, ts: 0, target: 'main', requestId: 'r1', method: 'GET', url: long }]),
    });
    const { text } = await callText(client, 'network', {});
    expect(text).toContain(`GET ${long.slice(0, 160)}…(+${long.length - 160} chars) → pending`);
    const refused = await callText(client, 'logs', { level: 'error' });
    expect(refused.text).toMatch(/unknown field "level"; fields: .*minLevel/);
  });
});

describe('ipc tool', () => {
  it('lists the channel catalogue and messages with correlation and trust flags', async () => {
    const channels = Array.from({ length: 42 }, (_, index) => ({
      channel: `ch${index}`,
      kinds: ['invoke', 'handle'],
      count: index,
    }));
    const client = await connectedWith({
      'ipc.query': { data: { items: [], channels, nextSeq: 0, dropped: 0, more: false }, limitations: [] },
    });
    const empty = await callText(client, 'ipc', { channel: 'orders:*' });
    expect(empty.text).toContain('No IPC messages.');
    expect(empty.text).toContain('ch0 (invoke/handle ×0), ch1');
    expect(empty.text).toContain(', … 2 more');
    const busy = await connectedWith({
      'ipc.query': {
        data: {
          items: [
            {
              seq: 1,
              ts: 0,
              corr: 'c1',
              correlation: 'heuristic',
              channel: 'orders:save',
              kind: 'invoke',
              phase: 'request',
              side: 'renderer',
              trust: 'low',
              sender: { target: 'main' },
              argShape: '[object]',
              values: [{ id: 1 }],
              durMs: 3,
            },
          ],
          channels: [],
          nextSeq: 1,
          dropped: 0,
          more: false,
        },
        limitations: [],
      },
    });
    const { text } = await callText(busy, 'ipc');
    expect(text).toContain('channels: none seen yet');
    expect(text).toContain(
      '#1 renderer invoke request "orders:save" from main corr=c1 3 ms args [object] = [{"id":1}] [correlation guessed, low trust]',
    );
  });

  it('lists inferred channel types and the direction of utility and port messages', async () => {
    const channels = [
      {
        channel: 'orders:save',
        kinds: ['handle', 'invoke'],
        count: 4,
        schema: { request: '(a: {id: number})', response: 'boolean', samples: 2 },
      },
      { channel: 'push:tick', kinds: ['send'], count: 1 },
    ];
    const items = [
      {
        seq: 1,
        ts: 0,
        corr: 'c1',
        correlation: 'exact',
        channel: 'utility:echo',
        kind: 'utilityMessage',
        phase: 'request',
        side: 'main',
        direction: 'out',
        trust: 'high',
        sender: { target: 'u7' },
        argShape: 'string[1]',
      },
    ];
    const client = await connectedWith({
      'ipc.query': { data: { items, channels, nextSeq: 1, dropped: 0, more: false }, limitations: [] },
    });
    const { text } = await callText(client, 'ipc', { schemas: true });
    expect(calls.at(-1)?.params).toMatchObject({ schemas: true });
    expect(text).toContain('orders:save (handle/invoke ×4): (a: {id: number}) → boolean [2 sample(s)]');
    expect(text).toContain('push:tick (send ×1): types unknown (seen only in renderers)');
    expect(text).toContain('#1 main utilityMessage out request "utility:echo" to u7 corr=c1');
  });
});
