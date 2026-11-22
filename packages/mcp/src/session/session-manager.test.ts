import type { BridgeClient, ConnectOptions } from '@eab/client';
import { describe, expect, it } from 'vitest';

import { SessionManager, type ClientApi } from './session-manager.js';

interface FakeClient {
  closed: boolean;
  readonly handshake: { pid: number };
  readonly session: { role: 'controller' | 'observer' };
  close(): void;
}

/** Fake client API; `roles` scripts the role each successive connection gets (default controller). */
function fakeApi(roles: ('controller' | 'observer')[] = []): {
  api: ClientApi;
  created: FakeClient[];
  options: ConnectOptions[];
} {
  const created: FakeClient[] = [];
  const options: ConnectOptions[] = [];
  const api: ClientApi = {
    connect: async (connectOptions) => {
      options.push(connectOptions);
      // Yield so overlapping calls really overlap.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const client: FakeClient = {
        closed: false,
        handshake: { pid: 1 },
        session: { role: roles[created.length] ?? 'controller' },
        close() {
          this.closed = true;
        },
      };
      created.push(client);
      return client as unknown as BridgeClient;
    },
    listInstances: () => [],
    launch: () => Promise.reject(new Error('not used')),
  };
  return { api, created, options };
}

describe('SessionManager', () => {
  it('launches with eval only when the operator allowed it', async () => {
    const denied = new SessionManager(fakeApi().api);
    await expect(denied.launch({ executable: 'app', allowEval: true })).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
    });
    for (const flag of [
      '--inspect=9229',
      '--inspect-brk',
      '--remote-debugging-port=9222',
      '--js-flags=--x',
    ]) {
      await expect(denied.launch({ executable: 'app', args: [flag, './app'] })).rejects.toMatchObject({
        code: 'CAPABILITY_DENIED',
        message: expect.stringContaining(flag) as unknown,
      });
    }
    await expect(denied.launch({ executable: 'app', args: ['--inspector-ui', './app'] })).rejects.toThrow(
      'not used',
    );
    const allowed = new SessionManager(fakeApi().api, { allowEval: true });
    await expect(allowed.launch({ executable: 'app', allowEval: true })).rejects.toThrow('not used');
  });

  it('does not let a close during attach bring the session back, and keeps a launched app on attach', async () => {
    const attached: FakeClient[] = [];
    let launchedClosed = 0;
    const api: ClientApi = {
      ...fakeApi().api,
      launch: () => {
        const client = {
          closed: false,
          handshake: { pid: 2 },
          session: { role: 'controller' },
          close: () => undefined,
        };
        return Promise.resolve({
          pid: 2,
          client: client as unknown as BridgeClient,
          close: () => {
            launchedClosed++;
            return Promise.resolve();
          },
        } as never);
      },
      attach: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const client: FakeClient = {
          closed: false,
          handshake: { pid: 3 },
          session: { role: 'controller' },
          close() {
            this.closed = true;
          },
        };
        attached.push(client);
        return client as unknown as BridgeClient;
      },
    };
    const sessions = new SessionManager(api, { allowEval: true });
    await sessions.launch({ executable: 'app', args: ['--remote-debugging-port=9222'] });
    await sessions.attach({ port: 9222 });
    expect(launchedClosed).toBe(0);
    expect(sessions.launchedApp()).toBeDefined();
    const pending = sessions.attach({ port: 9222 });
    sessions.close();
    await expect(pending).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(attached.at(-1)?.closed).toBe(true);
    expect(sessions.status()).toBeUndefined();
    expect(launchedClosed).toBe(1);
  });

  it('fails with a hint before any connect', async () => {
    await expect(new SessionManager(fakeApi().api).current()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reconnects once when concurrent callers find the connection dropped', async () => {
    const { api, created } = fakeApi();
    const sessions = new SessionManager(api);
    await sessions.connect({});
    created[0]!.closed = true;
    const [a, b, c] = await Promise.all([sessions.current(), sessions.current(), sessions.current()]);
    expect(created).toHaveLength(2);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('reconnects with the same role and capabilities, not as a default controller', async () => {
    const { api, created, options } = fakeApi(['observer', 'observer']);
    const sessions = new SessionManager(api);
    await sessions.connect({ role: 'observer', capabilities: ['observe'] });
    created[0]!.closed = true;
    await sessions.current();
    expect(options[1]).toEqual({ role: 'observer', capabilities: ['observe'], pid: 1 });
  });

  it('retries briefly when giving up control and getting it back races the old disconnect', async () => {
    const { api, created } = fakeApi(['controller', 'observer', 'observer', 'controller']);
    const sessions = new SessionManager(api, { handoverDelayMs: 1 });
    await sessions.connect({});
    const again = await sessions.connect({});
    expect(again.session.role).toBe('controller');
    expect(created.map((client) => client.closed)).toEqual([true, true, true, false]);
  });

  it('accepts being an observer when someone else really controls the app', async () => {
    const { api } = fakeApi(['controller', ...Array<'observer'>(10).fill('observer')]);
    const sessions = new SessionManager(api, { handoverRetries: 3, handoverDelayMs: 1 });
    await sessions.connect({});
    expect((await sessions.connect({})).session.role).toBe('observer');
  });

  it('keeps only the last of overlapping connects open', async () => {
    const { api, created } = fakeApi();
    const sessions = new SessionManager(api);
    const [first, second] = await Promise.all([
      sessions.connect({ role: 'observer' }),
      sessions.connect({ role: 'observer' }),
    ]);
    expect(first).not.toBe(second);
    expect(created.map((client) => client.closed)).toEqual([true, false]);
    expect(sessions.status()).toBe(second);
  });

  it('recovers after a failed connect', async () => {
    const { api } = fakeApi();
    let fail = true;
    const sessions = new SessionManager({
      ...api,
      connect: (options) => (fail ? Promise.reject(new Error('down')) : api.connect(options)),
    });
    await expect(sessions.connect({})).rejects.toThrow('down');
    fail = false;
    await expect(sessions.connect({})).resolves.toBeDefined();
  });
});
