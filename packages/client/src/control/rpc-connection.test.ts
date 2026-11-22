import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BridgeError, socketPath } from '@eab/core';
import { afterEach, describe, expect, it } from 'vitest';

import { RpcConnection } from './rpc-connection.js';

type Responder = (request: { id: number; method: string }, socket: Socket) => void;

let server: Server | undefined;

async function serve(respond: Responder): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'eab-'));
  const nonce = randomBytes(4).toString('hex');
  const path = socketPath({ platform: process.platform, directory, pid: process.pid, nonce });
  server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) respond(JSON.parse(line) as { id: number; method: string }, socket);
    });
  });
  const listening = server;
  await new Promise<void>((resolve) => listening.listen(path, resolve));
  return path;
}

afterEach(async () => {
  const closing = server;
  server = undefined;
  if (closing) await new Promise((resolve) => closing.close(resolve));
});

describe('RpcConnection', () => {
  it('matches responses to requests by id, in any order', async () => {
    const held: { id: number; socket: Socket }[] = [];
    const path = await serve((request, socket) => {
      held.push({ id: request.id, socket });
      if (held.length < 2) return;
      for (const entry of held.reverse()) {
        entry.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: entry.id, result: entry.id * 10 })}\n`);
      }
    });
    const connection = await RpcConnection.open(path, 1_000);
    await expect(Promise.all([connection.call('a', {}), connection.call('b', {})])).resolves.toEqual([
      10, 20,
    ]);
    connection.close();
  });

  it('turns error responses into BridgeErrors with code and hint', async () => {
    const path = await serve((request, socket) => {
      const error = { code: -32000, message: 'nope', data: { code: 'NOT_FOUND', hint: 'look elsewhere' } };
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error })}\n`);
    });
    const connection = await RpcConnection.open(path, 1_000);
    await expect(connection.call('x', {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
      hint: 'look elsewhere',
    });
    connection.close();
  });

  it('keeps error codes from a newer runtime instead of dropping the response', async () => {
    const path = await serve((request, socket) => {
      const error = { code: -32000, message: 'slow down', data: { code: 'RATE_LIMITED' } };
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error })}\n`);
    });
    const connection = await RpcConnection.open(path, 1_000);
    await expect(connection.call('x', {}, 5_000)).rejects.toMatchObject({
      code: 'INTERNAL',
      message: '[RATE_LIMITED] slow down',
    });
    connection.close();
  });

  it('fails a call at once when its response is malformed', async () => {
    const path = await serve((request, socket) => {
      socket.write(`${JSON.stringify({ jsonrpc: '1.0', id: request.id, result: 1 })}\n`);
    });
    const connection = await RpcConnection.open(path, 1_000);
    await expect(connection.call('x', {}, 5_000)).rejects.toMatchObject({ code: 'INTERNAL' });
    connection.close();
  });

  it('times out calls that never answer', async () => {
    const path = await serve(() => undefined);
    const connection = await RpcConnection.open(path, 1_000);
    await expect(connection.call('slow', {}, 50)).rejects.toMatchObject({ code: 'TIMEOUT' });
    connection.close();
  });

  it('fails pending and later calls when the peer hangs up', async () => {
    const path = await serve((_request, socket) => socket.destroy());
    const connection = await RpcConnection.open(path, 1_000);
    await expect(connection.call('x', {})).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' });
    expect(connection.closed).toBe(true);
    await expect(connection.call('y', {})).rejects.toBeInstanceOf(BridgeError);
  });

  it('reports an unreachable endpoint as TRANSPORT_CLOSED', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'eab-'));
    const path = socketPath({ platform: process.platform, directory, pid: 1, nonce: 'missing' });
    await expect(RpcConnection.open(path, 1_000)).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' });
  });
});
