import type { TargetKind } from '@eab/core';
import { z } from 'zod';

import type { CdpEvent, CdpTransport, DetachReason, Disposable } from '../ports/cdp-transport.js';

const Attached = z.object({
  sessionId: z.string(),
  targetInfo: z.object({
    targetId: z.string(),
    type: z.string(),
    url: z.string(),
    title: z.string().optional(),
  }),
});
const Detached = z.object({ sessionId: z.string() });
const InfoChanged = z.object({
  targetInfo: z.object({ targetId: z.string(), url: z.string(), title: z.string().optional() }),
});

/** Children followed per page, its frames' children included (a page spawning workers in a loop). */
export const MAX_CHILDREN = 50;

/** One auto-attached child of a page: a cross-origin iframe, a dedicated or shared worker, a service worker. */
export interface ChildTarget {
  /** `<page id>:<f|w|s><n>`, stable while the child lives. */
  readonly id: string;
  readonly parentId: string;
  /** `frame` for cross-origin iframes; workers and service workers are listed as targets of their own. */
  readonly kind: 'frame' | Extract<TargetKind, 'worker' | 'serviceWorker'>;
  readonly targetId: string;
  url: string;
  title: string;
  readonly transport: CdpTransport;
}

/** What to do with each child as it attaches (e.g. collect its logs); disposed when it goes. */
export type ChildHandler = (child: ChildTarget) => Disposable;

const KINDS: Readonly<Record<string, ChildTarget['kind']>> = {
  iframe: 'frame',
  worker: 'worker',
  shared_worker: 'worker',
  service_worker: 'serviceWorker',
};
const PREFIX: Readonly<Record<ChildTarget['kind'], string>> = { frame: 'f', worker: 'w', serviceWorker: 's' };

/**
 * A child session of a page's CDP connection as a transport of its own: commands carry the session id,
 * and only its events are delivered (without the id), so collectors written for pages work unchanged.
 */
export class ChildSessionTransport implements CdpTransport {
  readonly #parent: CdpTransport;
  readonly #sessionId: string;
  readonly #detachListeners = new Set<(reason: DetachReason) => void>();
  #closed: DetachReason | undefined;

  constructor(parent: CdpTransport, sessionId: string) {
    this.#parent = parent;
    this.#sessionId = sessionId;
  }

  get kind(): CdpTransport['kind'] {
    return this.#parent.kind;
  }

  get attached(): boolean {
    return this.#closed === undefined && this.#parent.attached;
  }

  get detachedReason(): DetachReason | undefined {
    return this.#closed ?? this.#parent.detachedReason;
  }

  /** A session id of its own (a grandchild's, flattened onto the same connection) goes as it is. */
  send(method: string, params?: object, sessionId?: string): Promise<unknown> {
    return this.#parent.send(method, params, sessionId ?? this.#sessionId);
  }

  post(method: string, params?: object, sessionId?: string): void {
    this.#parent.post(method, params, sessionId ?? this.#sessionId);
  }

  /**
   * This session's events without their id; events of other sessions keep theirs, so a grandchild's
   * transport built on this one still sees its own (page consumers ignore events with a session id).
   */
  onEvent(listener: (event: CdpEvent) => void): Disposable {
    return this.#parent.onEvent((event) => {
      if (this.#closed !== undefined || event.sessionId === undefined) return;
      listener(event.sessionId === this.#sessionId ? { method: event.method, params: event.params } : event);
    });
  }

  onDetach(listener: (reason: DetachReason) => void): Disposable {
    this.#detachListeners.add(listener);
    const parent = this.#parent.onDetach((reason) => {
      listener(reason);
    });
    return {
      dispose: () => {
        this.#detachListeners.delete(listener);
        parent.dispose();
      },
    };
  }

  /** A child session never re-attaches: a new one is a new child. */
  onAttach(): Disposable {
    return { dispose: () => undefined };
  }

  /** The child went away (detached from its target). */
  markClosed(reason: DetachReason): void {
    if (this.#closed !== undefined) return;
    this.#closed = reason;
    for (const listener of [...this.#detachListeners]) listener(reason);
  }

  close(): Promise<void> {
    this.markClosed('closed');
    return Promise.resolve();
  }
}

interface Followed {
  readonly child: ChildTarget;
  readonly handled: Disposable;
}

interface Standby {
  readonly parentId: string;
  readonly transport: CdpTransport;
  readonly attached: z.infer<typeof Attached>;
}

/** The page a child belongs to: the first part of its id (`wc3` of `wc3:f1:w2`). */
function pageOf(id: string): string {
  return id.split(':')[0] ?? id;
}

/**
 * Auto-attached children of every page (protocol 1.1): `Target.setAutoAttach` (flattened, never
 * pausing them) is posted fire-and-forget on each page and again after every re-attach (ADR-0002).
 * Each child's session becomes a {@link ChildSessionTransport} handed to the handler; children of
 * children (a worker in a cross-origin iframe) are followed the same way.
 */
export class ChildSessions {
  readonly #handler: ChildHandler;
  readonly #children = new Map<string, Followed>();
  readonly #counters = new Map<string, number>();
  /**
   * Other pages' sessions to a child already followed (a shared service worker): kept attached and
   * idle, so one can take over when the page it is followed under goes away.
   */
  readonly #standby: Standby[] = [];

  constructor(handler: ChildHandler) {
    this.#handler = handler;
  }

  /** Children currently attached, of every page. */
  list(): readonly ChildTarget[] {
    return [...this.#children.values()].map(({ child }) => child);
  }

  watch(parentId: string, transport: CdpTransport): Disposable {
    const autoAttach = (): void => {
      transport.post('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
    };
    const subscriptions = [
      transport.onEvent((event) => {
        // Only this transport's own session: nested children arrive on their parent child's transport.
        if (event.sessionId === undefined) this.#onEvent(parentId, transport, event);
      }),
      transport.onAttach(() => {
        this.#forgetChildrenOf(parentId, 'target-closed');
        autoAttach();
      }),
      transport.onDetach(() => {
        this.#forgetChildrenOf(parentId, 'target-closed');
      }),
    ];
    if (transport.attached) autoAttach();
    return {
      dispose: () => {
        for (const subscription of subscriptions) subscription.dispose();
        this.#forgetChildrenOf(parentId, 'target-closed');
      },
    };
  }

  #onEvent(parentId: string, transport: CdpTransport, event: CdpEvent): void {
    if (event.method === 'Target.attachedToTarget') {
      const parsed = Attached.safeParse(event.params);
      if (parsed.success) this.#attach(parentId, transport, parsed.data);
    } else if (event.method === 'Target.detachedFromTarget') {
      const parsed = Detached.safeParse(event.params);
      if (parsed.success) this.#detach(parsed.data.sessionId, 'target-closed');
    } else if (event.method === 'Target.targetInfoChanged') {
      const parsed = InfoChanged.safeParse(event.params);
      if (!parsed.success) return;
      for (const { child } of this.#children.values()) {
        if (child.targetId !== parsed.data.targetInfo.targetId) continue;
        child.url = parsed.data.targetInfo.url;
        child.title = parsed.data.targetInfo.title ?? child.title;
      }
    }
  }

  #attach(parentId: string, transport: CdpTransport, attached: z.infer<typeof Attached>): void {
    const kind = KINDS[attached.targetInfo.type];
    if (kind === undefined || this.#children.has(attached.sessionId)) return;
    // A service worker shared by several pages is attached under each: follow it once, keep the rest.
    const already = [...this.#children.values()].some(
      ({ child }) => child.targetId === attached.targetInfo.targetId,
    );
    if (already) {
      this.#standby.push({ parentId, transport, attached });
      return;
    }
    const page = pageOf(parentId);
    const ofPage = [...this.#children.values()].filter(({ child }) => pageOf(child.id) === page).length;
    if (ofPage >= MAX_CHILDREN) {
      transport.post('Target.detachFromTarget', { sessionId: attached.sessionId });
      return;
    }
    this.#adopt(kind, parentId, transport, attached);
  }

  #adopt(
    kind: ChildTarget['kind'],
    parentId: string,
    transport: CdpTransport,
    attached: z.infer<typeof Attached>,
  ): void {
    const counter = (this.#counters.get(parentId) ?? 0) + 1;
    this.#counters.set(parentId, counter);
    const childTransport = new ChildSessionTransport(transport, attached.sessionId);
    const child: ChildTarget = {
      id: `${parentId}:${PREFIX[kind]}${counter}`,
      parentId,
      kind,
      targetId: attached.targetInfo.targetId,
      url: attached.targetInfo.url,
      title: attached.targetInfo.title ?? '',
      transport: childTransport,
    };
    let handled: Disposable = { dispose: () => undefined };
    try {
      handled = this.#handler(child);
    } catch {
      // The child is listed even if collecting from it failed.
    }
    // Grandchildren (a worker inside a cross-origin iframe) are followed through the child's own session.
    const nested = this.watch(child.id, childTransport);
    this.#children.set(attached.sessionId, {
      child,
      handled: {
        dispose: () => {
          nested.dispose();
          handled.dispose();
        },
      },
    });
  }

  #detach(sessionId: string, reason: DetachReason): void {
    const waiting = this.#standby.findIndex((entry) => entry.attached.sessionId === sessionId);
    if (waiting !== -1) {
      this.#standby.splice(waiting, 1);
      return;
    }
    const followed = this.#children.get(sessionId);
    if (!followed) return;
    this.#children.delete(sessionId);
    (followed.child.transport as ChildSessionTransport).markClosed(reason);
    followed.handled.dispose();
    // Another page still has a session to it: follow it there.
    const next = this.#standby.findIndex(
      (entry) => entry.attached.targetInfo.targetId === followed.child.targetId,
    );
    const [taking] = next === -1 ? [] : this.#standby.splice(next, 1);
    if (taking !== undefined)
      this.#adopt(followed.child.kind, taking.parentId, taking.transport, taking.attached);
  }

  #forgetChildrenOf(parentId: string, reason: DetachReason): void {
    // Standby sessions of the page go first, so none of them takes over from a page that is going.
    for (let index = this.#standby.length - 1; index >= 0; index--) {
      if (this.#standby[index]?.parentId === parentId) this.#standby.splice(index, 1);
    }
    for (const [sessionId, { child }] of [...this.#children]) {
      if (child.parentId === parentId) this.#detach(sessionId, reason);
    }
  }
}
