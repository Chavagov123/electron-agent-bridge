import { channel } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';

import { NetworkLog } from '@eab/engine';
import { afterEach, describe, expect, it } from 'vitest';

import { MainNetworkCapture, type NetLike } from './main-network.js';

const clock = { now: () => 0, sleep: () => Promise.resolve() };
let capture: MainNetworkCapture | undefined;

afterEach(() => {
  capture?.stop();
  capture = undefined;
});

function setup(net?: NetLike): { log: NetworkLog; tick: (ms: number) => void } {
  let now = 1_000;
  const log = new NetworkLog(clock, {
    onActivate: () => {
      capture?.start();
    },
  });
  capture = new MainNetworkCapture({
    sink: {
      begin: (...args) => {
        log.begin(...args);
      },
      end: (...args) => {
        log.end(...args);
      },
    },
    ...(net === undefined ? {} : { net }),
    now: () => now,
  });
  return {
    log,
    tick: (ms) => {
      now += ms;
    },
  };
}

const items = (log: NetworkLog) =>
  log.query().items.map(({ target, method, url, status, mimeType, failed, resourceType, durMs }) => ({
    target,
    method,
    url,
    status,
    mimeType,
    failed,
    resourceType,
    durMs,
  }));

describe('MainNetworkCapture', () => {
  it('records Node http and fetch requests from their diagnostics channels once recording starts', async () => {
    const { log, tick } = setup();
    const early = { method: 'GET', path: '/early', protocol: 'http:', getHeader: () => 'example.test' };
    channel('http.client.request.start').publish({ request: early });
    await log.activate();
    const request = {
      method: 'POST',
      path: '/orders?token=s3cret',
      protocol: 'https:',
      getHeader: () => 'api.test',
    };
    channel('http.client.request.start').publish({ request });
    tick(25);
    channel('http.client.response.finish').publish({
      request,
      response: { statusCode: 201, headers: { 'content-type': 'application/json; charset=utf-8' } },
    });
    const fetched = { method: 'GET', origin: 'http://127.0.0.1:9', path: '/data' };
    channel('undici:request:create').publish({ request: fetched });
    channel('undici:request:headers').publish({
      request: fetched,
      response: { statusCode: 404, headers: [Buffer.from('Content-Type'), Buffer.from('text/plain')] },
    });
    const broken = { method: 'GET', origin: 'http://127.0.0.1:9', path: '/down' };
    channel('undici:request:create').publish({ request: broken });
    channel('undici:request:error').publish({ request: broken, error: new Error('ECONNREFUSED') });
    expect(items(log)).toEqual([
      {
        target: 'main',
        method: 'POST',
        url: 'https://api.test/orders?token=%5Bredacted%5D',
        status: 201,
        mimeType: 'application/json',
        failed: undefined,
        resourceType: 'Node http',
        durMs: 25,
      },
      {
        target: 'main',
        method: 'GET',
        url: 'http://127.0.0.1:9/data',
        status: 404,
        mimeType: 'text/plain',
        failed: undefined,
        resourceType: 'fetch',
        durMs: 0,
      },
      {
        target: 'main',
        method: 'GET',
        url: 'http://127.0.0.1:9/down',
        status: undefined,
        mimeType: undefined,
        failed: 'ECONNREFUSED',
        resourceType: 'fetch',
        durMs: 0,
      },
    ]);
  });

  it('wraps net.request, delegating unchanged, and restores it on stop', async () => {
    const made: EventEmitter[] = [];
    const net: NetLike = {
      request: (...args: unknown[]) => {
        const request = Object.assign(new EventEmitter(), { args });
        made.push(request);
        return request;
      },
    };
    const original = net.request;
    const { log } = setup(net);
    await log.activate();
    const first = net.request({
      method: 'put',
      protocol: 'https:',
      hostname: 'up.test',
      port: 8443,
      path: '/x',
    });
    expect(made[0]).toBe(first);
    (first as EventEmitter).emit('response', { statusCode: 204, headers: {} });
    const second = net.request('https://down.test/') as EventEmitter;
    second.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED'));
    const third = net.request({ url: 'https://slow.test/' }) as EventEmitter;
    third.emit('abort');
    expect(items(log).map(({ method, url, status, failed }) => [method, url, status, failed])).toEqual([
      ['PUT', 'https://up.test:8443/x', 204, undefined],
      ['GET', 'https://down.test/', undefined, 'net::ERR_NAME_NOT_RESOLVED'],
      ['GET', 'https://slow.test/', undefined, 'canceled'],
    ]);
    capture?.stop();
    expect(net.request).toBe(original);
    channel('http.client.request.start').publish({ request: { method: 'GET', path: '/after' } });
    expect(log.query().items).toHaveLength(3);
  });
});
