import { describe, expect, it } from 'vitest';

import { FakeCdpTransport } from '../testing/fake-cdp-transport.js';
import { FakeClock } from '../testing/fake-clock.js';
import { MAX_IN_FLIGHT, NetworkLog } from './network-log.js';
import { MAX_URL_CHARS, safeUrl } from './url-privacy.js';

function setup() {
  const log = new NetworkLog(new FakeClock());
  const page = new FakeCdpTransport().handle('Network.enable', () => ({}));
  const watching = log.watch('wc1', page);
  const sent = (requestId: string, url: string, timestamp: number, extra: object = {}) => {
    page.emit({
      method: 'Network.requestWillBeSent',
      params: {
        requestId,
        request: { url, method: 'GET' },
        timestamp,
        wallTime: 1_700_000_000 + timestamp,
        type: 'Fetch',
        ...extra,
      },
    });
  };
  const response = (requestId: string, status: number, extra: object = {}) => {
    page.emit({
      method: 'Network.responseReceived',
      params: { requestId, response: { status, mimeType: 'application/json', ...extra } },
    });
  };
  const finished = (requestId: string, timestamp: number, encodedDataLength = 120) => {
    page.emit({ method: 'Network.loadingFinished', params: { requestId, timestamp, encodedDataLength } });
  };
  const failed = (requestId: string, timestamp: number, extra: object) => {
    page.emit({
      method: 'Network.loadingFailed',
      params: { requestId, timestamp, errorText: 'net::ERR_FAILED', ...extra },
    });
  };
  return { log, page, watching, sent, response, finished, failed };
}

describe('NetworkLog', () => {
  it('marks responses a service worker served, and takes requests from other sources', async () => {
    const { log, sent, response, finished } = setup();
    sent('1', 'http://127.0.0.1/sw', 1);
    response('1', 200, { fromServiceWorker: true });
    finished('1', 1.01);
    let activated = 0;
    const external = new NetworkLog(new FakeClock(), { onActivate: () => (activated += 1) });
    await external.activate();
    await external.activate();
    external.begin(
      'main',
      'm1',
      { method: 'GET', url: 'https://x.test/?password=p', ts: 5, resourceType: 'fetch' },
      2,
    );
    external.end('main', 'm1', { status: 200, encodedBytes: 10.4 }, 2.5);
    external.end('main', 'unknown', { status: 500 }, 3);
    expect(log.query().items[0]?.fromServiceWorker).toBe(true);
    expect(activated).toBe(1);
    expect(external.query().items).toEqual([
      {
        seq: 1,
        ts: 5,
        target: 'main',
        requestId: 'm1',
        method: 'GET',
        url: 'https://x.test/?password=%5Bredacted%5D',
        resourceType: 'fetch',
        status: 200,
        encodedBytes: 10,
        durMs: 500,
      },
    ]);
  });

  it('stores a request once it finishes, with status, type, size and duration', () => {
    const { log, sent, response, finished } = setup();
    sent('1', 'http://127.0.0.1/api/orders', 10);
    response('1', 200);
    expect(log.query()).toMatchObject({ items: [], inFlight: 1 });
    finished('1', 10.0425);
    expect(log.query().items).toEqual([
      {
        seq: 1,
        ts: 1_700_000_010_000,
        target: 'wc1',
        requestId: '1',
        method: 'GET',
        url: 'http://127.0.0.1/api/orders',
        resourceType: 'Fetch',
        status: 200,
        mimeType: 'application/json',
        encodedBytes: 120,
        durMs: 42.5,
      },
    ]);
    expect(log.query().inFlight).toBe(0);
  });

  it('records each redirect hop, failures, blocked and canceled requests, and cache hits', () => {
    const { log, page, sent, response, finished, failed } = setup();
    sent('r', 'http://h/old', 1);
    sent('r', 'http://h/new', 2, { redirectResponse: { status: 302 } });
    response('r', 404);
    finished('r', 3);
    sent('f', 'http://h/down', 4);
    failed('f', 5, {});
    sent('b', 'http://h/ad', 6);
    failed('b', 6, { blockedReason: 'csp' });
    sent('c', 'http://h/aborted', 7);
    failed('c', 7, { canceled: true });
    sent('k', 'http://h/cached', 8);
    page.emit({ method: 'Network.requestServedFromCache', params: { requestId: 'k' } });
    response('k', 200, { fromDiskCache: true });
    finished('k', 8);
    response('unknown', 200);
    finished('unknown', 9);
    page.emit({ method: 'Network.dataReceived', params: {} });
    const items = log.query().items;
    expect(items.map(({ url, status, failed: why, fromCache }) => [url, status, why, fromCache])).toEqual([
      ['http://h/old', 302, undefined, undefined],
      ['http://h/new', 404, undefined, undefined],
      ['http://h/down', undefined, 'net::ERR_FAILED', undefined],
      ['http://h/ad', undefined, 'blocked: csp', undefined],
      ['http://h/aborted', undefined, 'canceled', undefined],
      ['http://h/cached', 200, undefined, true],
    ]);
    expect(log.query({ failedOnly: true }).items.map((record) => record.url)).toEqual([
      'http://h/new',
      'http://h/down',
      'http://h/ad',
      'http://h/aborted',
    ]);
    expect(log.query({ url: '*cached' }).items).toHaveLength(1);
    expect(log.query({ targetId: 'wc2' }).items).toHaveLength(0);
  });

  it('enables Network lazily, follows only the page session, forgets a closed page’s requests', async () => {
    const { log, page, watching, sent } = setup();
    expect(page.calls).toEqual([]);
    expect(await log.activate()).toBe(true);
    expect(page.calls.map((call) => call.method)).toEqual(['Network.enable']);
    page.emit({
      method: 'Network.requestWillBeSent',
      sessionId: 'worker',
      params: { requestId: 'w', request: { url: 'http://h/w', method: 'GET' }, timestamp: 1, wallTime: 1 },
    });
    sent('open', 'http://h/stream', 1);
    expect(log.query().inFlight).toBe(1);
    watching.dispose();
    expect(log.query().inFlight).toBe(0);
  });

  it('stores a page’s unfinished requests as such when its session ends or it is re-attached', () => {
    const { log, page, sent } = setup();
    sent('a', 'http://h/a', 1);
    page.detach('host-debugger');
    sent('b', 'http://h/b', 2);
    page.reattach();
    expect(log.query()).toMatchObject({ inFlight: 0 });
    expect(log.query().items.map((record) => [record.url, record.failed])).toEqual([
      ['http://h/a', 'unfinished (page session ended)'],
      ['http://h/b', 'unfinished (page session ended)'],
    ]);
  });

  it('a repeated request id replaces its entry without evicting another one', () => {
    const { log, sent } = setup();
    for (let index = 0; index < MAX_IN_FLIGHT; index++) sent(String(index), 'http://h/poll', index);
    sent('5', 'http://h/again', 2_000);
    expect(log.forgotten).toBe(0);
    expect(log.query().inFlight).toBe(MAX_IN_FLIGHT);
  });

  it('forgets the oldest unfinished requests beyond its bound, and counts them', () => {
    const { log, sent } = setup();
    for (let index = 0; index <= MAX_IN_FLIGHT; index++) sent(String(index), 'http://h/poll', index);
    expect(log.forgotten).toBe(1);
    expect(log.query().inFlight).toBe(MAX_IN_FLIGHT);
  });
});

describe('safeUrl', () => {
  it('redacts secret-looking query values and URL passwords, keeps the rest as sent', () => {
    expect(safeUrl('https://api.example/v1?token=abc&page=2&apiKey=k')).toBe(
      'https://api.example/v1?token=%5Bredacted%5D&page=2&apiKey=%5Bredacted%5D',
    );
    expect(safeUrl('https://user:secret@h/x')).toBe('https://user:%5Bredacted%5D@h/x');
    expect(safeUrl('https://h/a?q=hello%20world')).toBe('https://h/a?q=hello%20world');
    expect(safeUrl('not a url')).toBe('not a url');
  });

  it('reduces data URLs to their type and clips long URLs', () => {
    expect(safeUrl(`data:image/png;base64,${'A'.repeat(500)}`)).toBe('data:image/png;base64,… (522 chars)');
    expect(safeUrl(`https://h/${'a'.repeat(3_000)}`)).toHaveLength(MAX_URL_CHARS);
  });
});
