import { PROTOCOL_VERSION, ok, type Capability, type RpcResponse } from '@eab/core';
import { describe, expect, it } from 'vitest';

import type { AuditEntry, AuditSink } from '../audit/audit-log.js';
import { Authenticator } from './authenticator.js';
import { RpcSession, type MethodHandlers } from './rpc-session.js';
import { SessionRegistry } from './session-registry.js';

const TOKEN = 'token-abcdefghijklmnop';
const APP = { name: 'a', version: '1', electron: '45', pid: 1 };
const handlers: MethodHandlers = {
  'targets.list': () => ok({ targets: [] }),
  'snapshot.take': (input) =>
    ok({ target: input.target ?? 'wc1', url: 'u', title: 't', kind: 'full', text: '', lineCount: 0 }),
};

class MemoryAudit implements AuditSink {
  readonly entries: AuditEntry[] = [];
  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }
  close(): void {
    // Nothing to release.
  }
}

interface Setup {
  readonly capabilities?: Capability[];
  readonly sessions?: SessionRegistry;
  readonly audit?: MemoryAudit;
  readonly overrides?: Partial<MethodHandlers>;
}

function session({ capabilities = ['observe'], sessions, audit, overrides = {} }: Setup = {}): RpcSession {
  return new RpcSession({
    authenticator: new Authenticator({ token: TOKEN, capabilities }),
    sessions: sessions ?? new SessionRegistry(),
    audit: audit ?? new MemoryAudit(),
    handlers: { ...handlers, ...overrides },
    app: APP,
  });
}

const request = (id: number, method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params });
const auth = (token = TOKEN, extra: object = {}): string =>
  request(1, 'session.auth', {
    token,
    protocolVersion: PROTOCOL_VERSION,
    client: { name: 'tester', version: '0' },
    ...extra,
  });

function errorCode(response: RpcResponse): string | undefined {
  return 'error' in response ? response.error.data?.code : undefined;
}

function data(response: RpcResponse): Record<string, unknown> {
  return 'result' in response ? (response.result as { data: Record<string, unknown> }).data : {};
}

describe('RpcSession', () => {
  it('requires session.auth first and hangs up otherwise', async () => {
    const reply = await session().handleLine(request(1, 'targets.list', {}));
    expect(errorCode(reply.response)).toBe('UNAUTHORIZED');
    expect(reply.close).toBe(true);
  });

  it('hangs up on a wrong token', async () => {
    const reply = await session().handleLine(auth('wrong-token-abcdefghij'));
    expect(errorCode(reply.response)).toBe('UNAUTHORIZED');
    expect(reply.close).toBe(true);
  });

  it('dispatches validated calls after auth', async () => {
    const s = session();
    const granted = await s.handleLine(auth());
    expect(data(granted.response)).toMatchObject({
      capabilities: ['observe'],
      role: 'observer',
      app: APP,
      mode: 'integrated',
      features: ['pages', 'ipc', 'mainLogs', 'mainControl', 'state'],
    });
    const reply = await s.handleLine(request(2, 'snapshot.take', { target: 'wc7' }));
    expect(reply).toEqual({
      response: {
        jsonrpc: '2.0',
        id: 2,
        result: { data: expect.objectContaining({ target: 'wc7' }) as unknown, limitations: [] },
      },
      close: false,
    });
  });

  it('shapes results for a protocol 1.0 client: new target kinds as other, new IPC kinds left out', async () => {
    const target = (id: string, kind: string) => ({ id, name: id, kind, title: '', url: '', attached: true });
    const ipc = (kind: string, side: string) => ({ kind, side, channel: 'c' });
    const overrides = {
      'targets.list': () => ok({ targets: [target('wc1', 'window'), target('w1', 'worker')] }),
      'ipc.query': () =>
        ok({ items: [ipc('send', 'main'), ipc('bridgeCall', 'renderer'), ipc('send', 'utility')] }),
    } as unknown as Partial<MethodHandlers>;
    const read = async (version: string) => {
      const rpc = session({ overrides });
      await rpc.handleLine(auth(TOKEN, { protocolVersion: version }));
      const targets = data((await rpc.handleLine(request(2, 'targets.list'))).response);
      const events = data((await rpc.handleLine(request(3, 'ipc.query', {}))).response);
      return { targets: targets['targets'], items: events['items'] };
    };
    expect(await read('1.0.0')).toEqual({
      targets: [target('wc1', 'window'), target('w1', 'other')],
      items: [ipc('send', 'main')],
    });
    const current = await read(PROTOCOL_VERSION);
    expect(current.targets).toEqual([target('wc1', 'window'), target('w1', 'worker')]);
    expect(current.items).toHaveLength(3);
  });

  it('makes later clients observers until the controller disconnects', async () => {
    const sessions = new SessionRegistry();
    const first = session({ capabilities: ['observe', 'interact'], sessions });
    const second = session({ capabilities: ['observe', 'interact'], sessions });
    expect(data((await first.handleLine(auth())).response)).toMatchObject({ role: 'controller' });
    const observed = data((await second.handleLine(auth())).response);
    expect(observed).toMatchObject({ role: 'observer', capabilities: ['observe'] });
    const denied = await second.handleLine(
      request(2, 'action.run', { actions: [{ type: 'press', key: 'Enter' }] }),
    );
    expect(denied.response).toMatchObject({
      error: { data: { code: 'CAPABILITY_DENIED', hint: expect.stringContaining('observer') as unknown } },
    });
    first.dispose();
    const third = session({ capabilities: ['observe', 'interact'], sessions });
    expect(data((await third.handleLine(auth())).response)).toMatchObject({ role: 'controller' });
  });

  it('honours a client that asks to observe or for fewer capabilities', async () => {
    const asObserver = session({ capabilities: ['observe', 'interact'] });
    expect(data((await asObserver.handleLine(auth(TOKEN, { role: 'observer' }))).response)).toMatchObject({
      role: 'observer',
    });
    const leastPrivilege = session({ capabilities: ['observe', 'interact'] });
    expect(
      data((await leastPrivilege.handleLine(auth(TOKEN, { capabilities: ['observe'] }))).response),
    ).toMatchObject({ role: 'observer', capabilities: ['observe'] });
  });

  it('audits every call with metadata only', async () => {
    const audit = new MemoryAudit();
    const s = session({ audit });
    await s.handleLine(auth('wrong-token-abcdefghij'));
    const good = session({ audit });
    await good.handleLine(auth());
    await good.handleLine(request(2, 'targets.list', {}));
    await good.handleLine(request(3, 'app.info', {}));
    expect(
      audit.entries.map(({ method, ok: success, code, client }) => ({ method, success, code, client })),
    ).toEqual([
      { method: 'session.auth', success: false, code: 'UNAUTHORIZED', client: undefined },
      { method: 'session.auth', success: true, code: undefined, client: 'tester' },
      { method: 'targets.list', success: true, code: undefined, client: 'tester' },
      { method: 'app.info', success: false, code: 'UNSUPPORTED', client: 'tester' },
    ]);
    expect(JSON.stringify(audit.entries)).not.toContain(TOKEN);
    expect(audit.entries.every((entry) => entry.ms >= 0 && entry.ts > 0)).toBe(true);
  });

  it('reports invalid params, unknown methods and re-auth without hanging up', async () => {
    const s = session();
    await s.handleLine(auth());
    const invalid = await s.handleLine(request(2, 'snapshot.take', { target: 5 }));
    expect(errorCode(invalid.response)).toBe('INVALID_PARAMS');
    const unknown = await s.handleLine(request(3, 'nope', {}));
    expect(errorCode(unknown.response)).toBe('UNSUPPORTED');
    const again = await s.handleLine(auth());
    expect(errorCode(again.response)).toBe('INVALID_PARAMS');
    expect([invalid.close, unknown.close, again.close]).toEqual([false, false, false]);
  });

  it('answers malformed input with JSON-RPC errors', async () => {
    const s = session();
    expect((await s.handleLine('{not json')).response).toMatchObject({ id: null, error: { code: -32700 } });
    expect((await s.handleLine('{"id":1}')).response).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it('wraps handler failures as bridge errors', async () => {
    const failing = session({
      overrides: {
        'targets.list': () => {
          throw new Error('boom');
        },
      },
    });
    await failing.handleLine(auth());
    const reply = await failing.handleLine(request(2, 'targets.list', {}));
    expect(reply.response).toMatchObject({ error: { message: 'boom', data: { code: 'INTERNAL' } } });
    expect(reply.close).toBe(false);
  });

  it('answers UNSUPPORTED for methods the runtime does not implement yet', async () => {
    const s = session();
    await s.handleLine(auth());
    const reply = await s.handleLine(request(2, 'app.info', {}));
    expect(errorCode(reply.response)).toBe('UNSUPPORTED');
    expect(reply.close).toBe(false);
  });

  it('checks capabilities before reaching a handler', async () => {
    const s = session();
    await s.handleLine(auth());
    const reply = await s.handleLine(
      request(2, 'action.run', { actions: [{ type: 'press', key: 'Enter' }] }),
    );
    expect(errorCode(reply.response)).toBe('CAPABILITY_DENIED');
  });
});
