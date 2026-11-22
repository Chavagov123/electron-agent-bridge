import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROTOCOL_VERSION, encodeLine, handshakeFileName, socketPath, type Handshake } from '@eab/core';
import { afterEach, describe, expect, it } from 'vitest';

import { connect } from './connect.js';

const TOKEN = 'token-abcdefghijklmnop';
type Reply = (request: { id: number; method: string; params: unknown }) => unknown;

let server: Server | undefined;

/** A minimal stand-in runtime: answers each request with whatever `reply` returns (an RPC body). */
async function fakeApp(reply: Reply): Promise<{ directory: string; handshake: Handshake }> {
  const directory = mkdtempSync(join(tmpdir(), 'eab-'));
  const endpoint = socketPath({
    platform: process.platform,
    directory,
    pid: process.pid,
    nonce: randomBytes(4).toString('hex'),
  });
  server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const request = JSON.parse(line) as { id: number; method: string; params: unknown };
        socket.write(encodeLine({ jsonrpc: '2.0', id: request.id, ...(reply(request) as object) }));
      }
    });
  });
  const listening = server;
  await new Promise<void>((resolve) => listening.listen(endpoint, resolve));
  const handshake: Handshake = {
    schema: 1,
    protocolVersion: PROTOCOL_VERSION,
    pid: process.pid,
    startedAt: Date.now(),
    endpoint,
    token: TOKEN,
    app: { name: 'fake', version: '1.0.0' },
    electron: '45.0.0',
  };
  writeFileSync(join(directory, handshakeFileName(process.pid)), JSON.stringify(handshake), { mode: 0o600 });
  return { directory, handshake };
}

const granted = {
  result: {
    data: {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: 's1',
      role: 'controller',
      capabilities: ['observe'],
      app: { name: 'fake', version: '1.0.0', electron: '45.0.0', pid: process.pid },
    },
    limitations: [],
  },
};

afterEach(async () => {
  const closing = server;
  server = undefined;
  if (closing) await new Promise((resolve) => closing.close(resolve));
});

describe('connect', () => {
  it('authenticates with the handshake token, then makes validated, typed calls', async () => {
    const seen: unknown[] = [];
    const { directory } = await fakeApp((request) => {
      seen.push(request.params);
      if (request.method === 'session.auth') return granted;
      return { result: { data: { targets: [] }, limitations: [] } };
    });
    const client = await connect({ directory, pid: process.pid, client: { name: 'test', version: '9' } });
    try {
      expect(seen[0]).toEqual({
        token: TOKEN,
        protocolVersion: PROTOCOL_VERSION,
        client: { name: 'test', version: '9' },
      });
      expect(client.session.capabilities).toEqual(['observe']);
      expect(client.handshake.app.name).toBe('fake');
      await expect(client.call('targets.list', {})).resolves.toEqual({
        data: { targets: [] },
        limitations: [],
      });
      expect(client.closed).toBe(false);
    } finally {
      client.close();
    }
  });

  it('rejects results that do not match the protocol table', async () => {
    const { directory } = await fakeApp((request) =>
      request.method === 'session.auth'
        ? granted
        : { result: { data: { targets: 'nope' }, limitations: [] } },
    );
    const client = await connect({ directory });
    try {
      await expect(client.call('targets.list', {})).rejects.toMatchObject({ code: 'INTERNAL' });
    } finally {
      client.close();
    }
  });

  it('wraps a malformed auth result as a bridge error and closes the connection', async () => {
    const { directory } = await fakeApp(() => ({ result: { nonsense: true } }));
    await expect(connect({ directory })).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('surfaces auth failures from the app', async () => {
    const { directory } = await fakeApp(() => ({
      error: { code: -32000, message: 'invalid token', data: { code: 'UNAUTHORIZED' } },
    }));
    await expect(connect({ directory })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('explains when no app is running, or none with the requested pid', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'eab-'));
    await expect(connect({ directory: empty })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'no bridge-enabled app is running',
    });
    await expect(connect({ directory: empty, pid: 123 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'no bridge-enabled app with pid 123',
    });
  });

  it('connects through an explicit handshake path', async () => {
    const { directory } = await fakeApp(() => granted);
    const client = await connect({ handshakePath: join(directory, handshakeFileName(process.pid)) });
    client.close();
    expect(client.session.app.name).toBe('fake');
  });
});
