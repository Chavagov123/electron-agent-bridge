import { EventEmitter } from 'node:events';

import type { Debugger, WebContents } from 'electron';
import { describe, expect, it } from 'vitest';

import { guardHostDebugger } from './debugger-guard.js';
import { DebuggerSession } from './debugger-session.js';
import { InProcessDebuggerTransport } from './in-process-debugger-transport.js';

/** Just enough of Electron's Debugger: one holder at a time, like the real thing. */
class FakeDebugger extends EventEmitter {
  holder: 'none' | 'attached' = 'none';
  readonly sent: string[] = [];

  isAttached(): boolean {
    return this.holder === 'attached';
  }

  attach(): void {
    if (this.holder === 'attached') throw new Error('Debugger is already attached to the target');
    this.holder = 'attached';
  }

  detach(): void {
    this.holder = 'none';
  }

  sendCommand(method: string): Promise<unknown> {
    this.sent.push(method);
    if (method === 'Fail.now') return Promise.reject(new Error('boom'));
    return Promise.resolve({ method });
  }
}

class FakeContents extends EventEmitter {
  destroyed = false;
  readonly debugger = new FakeDebugger();
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

const asDebugger = (fake: FakeDebugger): Debugger => fake;
const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('InProcessDebuggerTransport', () => {
  it('attaches, sends, and only forwards events while attached', async () => {
    const fake = new FakeDebugger();
    const transport = new InProcessDebuggerTransport(asDebugger(fake));
    const methods: string[] = [];
    transport.onEvent((event) => methods.push(event.method));
    fake.emit('message', {}, 'Before.attach', {});
    expect(transport.attach()).toBe(true);
    await expect(transport.send('Runtime.evaluate')).resolves.toEqual({ method: 'Runtime.evaluate' });
    fake.emit('message', {}, 'Page.loadEventFired', {}, 'session-1');
    expect(methods).toEqual(['Page.loadEventFired']);
    transport.post('Fail.now');
    await expect(transport.send('Fail.now')).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('reports why it is detached and maps Electron detach reasons', () => {
    const fake = new FakeDebugger();
    const transport = new InProcessDebuggerTransport(asDebugger(fake));
    const reasons: string[] = [];
    transport.onDetach((reason) => reasons.push(reason));
    transport.attach();
    expect(transport.detachedReason).toBeUndefined();
    fake.emit('detach', {}, 'Render process gone.');
    fake.holder = 'none';
    expect(transport.detachedReason).toBe('crashed');
    transport.attach();
    fake.emit('detach', {}, 'target closed');
    expect(reasons).toEqual(['crashed', 'target-closed']);
  });

  it('stays detached with reason host-debugger when someone else holds the debugger', async () => {
    const fake = new FakeDebugger();
    fake.attach();
    const transport = new InProcessDebuggerTransport(asDebugger(fake));
    expect(transport.attach()).toBe(false);
    expect(transport.detachedReason).toBe('host-debugger');
    await expect(transport.send('X.y')).rejects.toMatchObject({ code: 'DETACHED' });
  });
});

describe('DebuggerSession', () => {
  function started(): { contents: FakeContents; session: DebuggerSession } {
    const contents = new FakeContents();
    const session = new DebuggerSession(contents as unknown as WebContents);
    session.start();
    return { contents, session };
  }

  it('yields to the host app and takes the debugger back when it detaches', async () => {
    const { contents, session } = started();
    expect(session.transport.attached).toBe(true);
    // The host app's own call succeeds exactly as it would without the bridge.
    expect(() => {
      contents.debugger.attach();
    }).not.toThrow();
    expect(session.transport.detachedReason).toBe('host-debugger');
    contents.debugger.detach();
    expect(session.transport.attached).toBe(false);
    await nextTick();
    expect(session.transport.attached).toBe(true);
  });

  it('is invisible to the host: isAttached() is false and the check-then-attach pattern works', async () => {
    const { contents, session } = started();
    expect(contents.debugger.isAttached()).toBe(false);
    if (!contents.debugger.isAttached()) contents.debugger.attach();
    expect(contents.debugger.isAttached()).toBe(true);
    expect(session.transport.detachedReason).toBe('host-debugger');
    contents.debugger.detach();
    await nextTick();
    expect(session.transport.attached).toBe(true);
    expect(contents.debugger.isAttached()).toBe(false);
  });

  it("ignores the host's defensive detach while only the bridge holds the debugger", async () => {
    const { contents, session } = started();
    contents.debugger.detach();
    await nextTick();
    expect(session.transport.attached).toBe(true);
    await expect(session.transport.send('Runtime.evaluate')).resolves.toBeDefined();
  });

  it('never re-attaches after stop, even if a deferred re-attach was pending', async () => {
    const { contents, session } = started();
    contents.debugger.attach();
    contents.debugger.detach();
    session.stop();
    await nextTick();
    expect(session.transport.attached).toBe(false);
    expect(contents.debugger.holder).toBe('none');
  });

  it('does not re-attach while the host still holds the debugger', async () => {
    const { contents, session } = started();
    contents.debugger.attach();
    contents.emit('did-start-loading');
    await nextTick();
    expect(session.transport.attached).toBe(false);
    expect(session.transport.detachedReason).toBe('host-debugger');
  });

  it('re-attaches when the page loads again after a crash', () => {
    const { contents, session } = started();
    contents.debugger.emit('detach', {}, 'Render process gone.');
    contents.debugger.holder = 'none';
    expect(session.transport.detachedReason).toBe('crashed');
    contents.emit('did-start-loading');
    expect(session.transport.attached).toBe(true);
  });

  it('restores the original methods and releases the debugger on stop', () => {
    const { contents, session } = started();
    expect(Object.hasOwn(contents.debugger, 'attach')).toBe(true);
    session.stop();
    expect(Object.hasOwn(contents.debugger, 'attach')).toBe(false);
    expect(Object.hasOwn(contents.debugger, 'detach')).toBe(false);
    expect(contents.debugger.isAttached()).toBe(false);
    expect(contents.listenerCount('did-start-loading')).toBe(0);
  });
});

describe('guardHostDebugger', () => {
  it('rethrows a failing host attach unchanged and reports the release', () => {
    const fake = new FakeDebugger();
    fake.attach = (): void => {
      throw new Error('host misuse');
    };
    const events: string[] = [];
    const restore = guardHostDebugger(asDebugger(fake), {
      bridgeHolds: () => false,
      beforeHostAttach: () => events.push('before'),
      afterHostRelease: () => events.push('released'),
    });
    expect(() => {
      fake.attach();
    }).toThrow('host misuse');
    fake.detach();
    expect(events).toEqual(['before', 'released', 'released']);
    restore();
    // Own properties set before guarding are restored as they were.
    expect(() => {
      fake.attach();
    }).toThrow('host misuse');
    expect(Object.hasOwn(fake, 'detach')).toBe(false);
  });
});
