/**
 * `@electron-agent-bridge/electron/renderer`: for the app's renderer code (page scripts, not preloads). Dependency-free
 * and safe to ship: without the bridge every call is a no-op.
 * @packageDocumentation
 */

/** The registry the bridge's state hook defines in each app page (same key as `@electron-agent-bridge/page-agent`). */
const STATE_KEY = Symbol.for('electron-agent-bridge.v1.state');
/** Registrations made before the hook ran (it can arrive late in a page's very first document). */
const PENDING_KEY = Symbol.for('electron-agent-bridge.v1.state-pending');
/** Kept until the hook takes them over; more are dropped (a page registering in a loop). */
const MAX_PENDING = 50;

interface Pending {
  readonly name: string;
  readonly store: unknown;
  readonly options: RegisterStateOptions;
  /** Set by the hook when it registers this entry: how to undo that. */
  undo?: () => void;
}

export interface RegisterStateOptions {
  /** How `state.dispatch` reaches a store that has no `dispatch` of its own (e.g. Zustand, MobX). */
  readonly dispatch?: (action: unknown) => unknown;
}

interface Registry {
  register(name: string, store: unknown, options: RegisterStateOptions): () => void;
}

/**
 * Make a store readable by agents (`state` tool): a Redux / RTK store, a Zustand store (or its hook),
 * a MobX observable, or any object or getter function (`() => model`). Returns how to unregister.
 * Values are read on demand, bounded and redacted; nothing is sent while nobody asks.
 *
 * Call it from page code: preloads run in an isolated world the hook does not see.
 */
export function registerState(name: string, store: unknown, options: RegisterStateOptions = {}): () => void {
  const page = globalThis as unknown as Record<symbol, unknown>;
  const registry = page[STATE_KEY] as Partial<Registry> | undefined;
  if (typeof registry?.register === 'function') {
    try {
      return registry.register(name, store, options);
    } catch {
      return () => undefined;
    }
  }
  // No hook (yet): queue it for the hook to take over. Without the bridge the queue just stays (it holds
  // stores the app keeps alive anyway).
  let pending = page[PENDING_KEY] as Pending[] | undefined;
  if (!Array.isArray(pending)) {
    pending = [];
    Object.defineProperty(page, PENDING_KEY, { value: pending, configurable: true, enumerable: false });
  }
  if (pending.length >= MAX_PENDING) return () => undefined;
  const entry: Pending = { name, store, options };
  pending.push(entry);
  const queue = pending;
  return () => {
    const index = queue.indexOf(entry);
    if (index !== -1) queue.splice(index, 1);
    entry.undo?.();
  };
}
