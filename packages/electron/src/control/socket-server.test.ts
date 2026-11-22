import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROTOCOL_VERSION, ok, socketPath } from '@eab/core';
import { afterEach, describe, expect, it } from 'vitest';

import { NO_AUDIT } from '../audit/audit-log.js';
import { Authenticator } from './authenticator.js';
import { RpcSession } from './rpc-session.js';
import { SessionRegistry } from './session-registry.js';
import { SocketServer } from './socket-server.js';

const TOKEN = 'token-abcdefghijklmnop';
const APP = { name: 'a', version: '1', electron: '45', pid: 1 };

function createServer(): SocketServer {
  const directory = mkdtempSync(join(tmpdir(), 'eab-'));
  const nonce = randomBytes(4).toString('hex');
  const path = socketPath({ platform: process.platform, directory, pid: process.pid, nonce });
  const sessions = new SessionRegistry();
  return new SocketServer({
    path,
    createSession: () =>
      new RpcSession({
        authenticator: new Authenticator({ token: TOKEN, capabilities: ['observe'] }),
        sessions,
        audit: NO_AUDIT,
        app: APP,
        handlers: {
          'targets.list': () => ok({ targets: [] }),
          'snapshot.take': () =>
            ok({ target: 'wc1', url: '', title: '', kind: 'full', text: '', lineCount: 0 }),
        },
      }),
    onError: () => undefined,
  });
}

interface Exchange {
  readonly responses: unknown[];
  readonly closed: boolean;
}

/** Send lines, collect responses until `count` arrive (we hang up) or the server closes first. */
function exchange(path: string, lines: string[], count: number): Promise<Exchange> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const responses: unknown[] = [];
    let buffer = '';
    socket.setEncoding('utf8');
    // A server that hangs up mid-write surfaces as EPIPE/EOF on our side: that is a close, not a failure.
    socket.on('error', () => socket.destroy());
    socket.on('connect', () => socket.write(lines.map((line) => `${line}\n`).join('')));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      responses.push(...parts.map((part) => JSON.parse(part) as unknown));
      if (responses.length >= count) {
        socket.removeAllListeners('close');
        socket.destroy();
        resolve({ responses, closed: false });
      }
    });
    socket.on('close', () => {
      resolve({ responses, closed: true });
    });
  });
}

const authLine = (token: string): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'session.auth',
    params: { token, protocolVersion: PROTOCOL_VERSION, client: { name: 't', version: '0' } },
  });

describe('SocketServer', () => {
  let current: SocketServer | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  async function listening(): Promise<string> {
    const server = createServer();
    current = server;
    return server.listen();
  }

  it('serves pipelined NDJSON requests after auth', async () => {
    const path = await listening();
    const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'targets.list', params: {} });
    const { responses } = await exchange(path, [authLine(TOKEN), list], 2);
    expect(responses[0]).toMatchObject({ id: 1, result: { data: { protocolVersion: PROTOCOL_VERSION } } });
    expect(responses[1]).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { data: { targets: [] }, limitations: [] },
    });
  });

  it('closes the connection after a failed auth', async () => {
    const path = await listening();
    const { responses, closed } = await exchange(path, [authLine('wrong-token-abcdefghij')], 2);
    expect(closed).toBe(true);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ error: { data: { code: 'UNAUTHORIZED' } } });
  });

  it('drops a peer that sends an oversized line', async () => {
    const path = await listening();
    const { responses, closed } = await exchange(path, ['x'.repeat(9 * 1024 * 1024)], 1);
    expect(closed).toBe(true);
    expect(responses).toHaveLength(0);
  });
});
