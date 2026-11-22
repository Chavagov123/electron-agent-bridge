import { describe, expect, it } from 'vitest';

import type { CdpEvent } from '../ports/cdp-transport.js';
import { FakeCdpTransport } from '../testing/fake-cdp-transport.js';
import { ChildSessions, MAX_CHILDREN, type ChildTarget } from './child-sessions.js';

const attached = (
  sessionId: string,
  type: string,
  url: string,
  options: { readonly targetId?: string; readonly parent?: string } = {},
): CdpEvent => ({
  method: 'Target.attachedToTarget',
  params: { sessionId, targetInfo: { targetId: options.targetId ?? sessionId, type, url, title: '' } },
  ...(options.parent === undefined ? {} : { sessionId: options.parent }),
});

function setup() {
  const page = new FakeCdpTransport();
  const seen: ChildTarget[] = [];
  const disposed: string[] = [];
  const children = new ChildSessions((child) => {
    seen.push(child);
    return { dispose: () => disposed.push(child.id) };
  });
  const watching = children.watch('wc1', page);
  return { page, seen, disposed, children, watching };
}

describe('ChildSessions', () => {
  it('auto-attaches without pausing children, and gives each its own transport', () => {
    const { page, seen, children } = setup();
    expect(page.calls).toEqual([
      {
        method: 'Target.setAutoAttach',
        params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        posted: true,
      },
    ]);
    page.emit(attached('s1', 'worker', 'http://x/w.js'));
    page.emit(attached('s2', 'iframe', 'http://y/frame'));
    page.emit(attached('s3', 'service_worker', 'http://x/sw.js'));
    page.emit(attached('s4', 'page', 'http://z/'));
    expect(children.list().map(({ id, kind, url }) => [id, kind, url])).toEqual([
      ['wc1:w1', 'worker', 'http://x/w.js'],
      ['wc1:f2', 'frame', 'http://y/frame'],
      ['wc1:s3', 'serviceWorker', 'http://x/sw.js'],
    ]);
    const worker = seen[0]!.transport;
    const events: CdpEvent[] = [];
    worker.onEvent((event) => events.push(event));
    page.emit({ method: 'Runtime.consoleAPICalled', params: { a: 1 }, sessionId: 's1' });
    page.emit({ method: 'Runtime.consoleAPICalled', params: { a: 2 }, sessionId: 's2' });
    page.emit({ method: 'Runtime.consoleAPICalled', params: { a: 3 } });
    // Its own events without the id; another session's keep theirs (page consumers ignore those).
    expect(events).toEqual([
      { method: 'Runtime.consoleAPICalled', params: { a: 1 } },
      { method: 'Runtime.consoleAPICalled', params: { a: 2 }, sessionId: 's2' },
    ]);
    worker.post('Runtime.enable');
    expect(page.calls.at(-1)).toMatchObject({ method: 'Runtime.enable', posted: true });
  });

  it('forgets children that detach, and all of a page’s children when its session ends', () => {
    const { page, children, disposed, seen } = setup();
    page.emit(attached('s1', 'worker', 'u1'));
    page.emit(attached('s2', 'worker', 'u2'));
    const reasons: string[] = [];
    seen[0]!.transport.onDetach((reason) => reasons.push(reason));
    page.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 's1' } });
    expect(children.list().map((child) => child.id)).toEqual(['wc1:w2']);
    expect(seen[0]!.transport.attached).toBe(false);
    expect(reasons).toEqual(['target-closed']);
    page.emit({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: { targetId: 's2', url: 'u2b', title: 'T' } },
    });
    expect(children.list()[0]).toMatchObject({ url: 'u2b', title: 'T' });
    page.detach('host-debugger');
    page.reattach();
    expect(children.list()).toEqual([]);
    expect(disposed).toEqual(['wc1:w1', 'wc1:w2']);
    // The page at start and after re-attaching, plus each child for its own children.
    expect(page.calls.filter((call) => call.method === 'Target.setAutoAttach')).toHaveLength(4);
  });

  it('follows a shared service worker once, and under another page when its page goes', () => {
    const { page, children } = setup();
    const other = new FakeCdpTransport();
    children.watch('wc2', other);
    page.emit(attached('s1', 'service_worker', 'sw', { targetId: 'SW' }));
    other.emit(attached('s2', 'service_worker', 'sw', { targetId: 'SW' }));
    expect(children.list().map((child) => child.id)).toEqual(['wc1:s1']);
    expect(other.calls.some((call) => call.method === 'Target.detachFromTarget')).toBe(false);
    page.detach('target-closed');
    expect(children.list().map((child) => child.id)).toEqual(['wc2:s1']);
  });

  it('follows grandchildren on their own sessions, through their parent child', () => {
    const { page, children, seen } = setup();
    page.emit(attached('s3', 'iframe', 'frame'));
    page.emit(attached('s4', 'worker', 'inner', { parent: 's3' }));
    expect(children.list().map((child) => child.id)).toEqual(['wc1:f1', 'wc1:f1:w1']);
    const grandchild = seen[1]!.transport;
    const events: CdpEvent[] = [];
    grandchild.onEvent((event) => events.push(event));
    grandchild.post('Runtime.enable');
    page.emit({ method: 'Runtime.consoleAPICalled', params: { from: 'worker' }, sessionId: 's4' });
    page.emit({ method: 'Runtime.consoleAPICalled', params: { from: 'frame' }, sessionId: 's3' });
    expect(events).toEqual([{ method: 'Runtime.consoleAPICalled', params: { from: 'worker' } }]);
  });

  it('caps children per page, not across pages', () => {
    const { page, children } = setup();
    const other = new FakeCdpTransport();
    children.watch('wc2', other);
    for (let index = 0; index < MAX_CHILDREN + 5; index++)
      page.emit(attached(`x${index}`, 'worker', `w${index}`));
    other.emit(attached('y', 'worker', 'other'));
    expect(children.list()).toHaveLength(MAX_CHILDREN + 1);
    expect(children.list().at(-1)?.id).toBe('wc2:w1');
  });
});
