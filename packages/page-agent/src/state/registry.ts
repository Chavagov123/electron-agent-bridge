import { lookup, parsePath } from './path.js';
import { DEFAULT_LIMITS, toJson } from './serialize.js';

export type StoreKind = 'redux' | 'zustand' | 'mobx' | 'generic';

/** How the app (or the devtools shim) describes a store beyond what can be detected. */
export interface RegisterOptions {
  readonly kind?: StoreKind;
  /** Called by `state.dispatch` for stores without a `dispatch` of their own. */
  readonly dispatch?: (action: unknown) => unknown;
}

export interface StoreInfo {
  readonly name: string;
  readonly kind: StoreKind;
  /** Updates observed since registration (dispatches for Redux, `setState` calls for Zustand). */
  readonly actions?: number;
}

/** A failure reported back as data (it crosses CDP as a value); the runtime turns it into a BridgeError. */
export interface StateFailure {
  readonly error: { readonly code: string; readonly message: string; readonly hint?: string };
}

export interface StateReadRequest {
  readonly store?: string;
  readonly path?: string;
  readonly maxDepth?: number;
}

export interface StateReadResult {
  readonly stores: StoreInfo[];
  readonly store?: string;
  readonly path?: string;
  readonly value: unknown;
  readonly truncated: boolean;
}

export interface StateDispatchRequest {
  readonly store?: string;
  readonly action: unknown;
}

interface Entry {
  readonly name: string;
  readonly kind: StoreKind;
  readonly read: () => unknown;
  readonly dispatch: ((action: unknown) => unknown) | undefined;
  updates: number | undefined;
  unsubscribe: () => void;
}

/** More are refused: a page creating stores in a loop must not grow the registry without bound. */
export const MAX_STORES = 50;

type Store = Record<string, unknown>;

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

function detectKind(target: unknown): StoreKind {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return 'generic';
  const store = target as Store;
  if (isFunction(store['getState']) && isFunction(store['subscribe'])) {
    if (isFunction(store['dispatch'])) return 'redux';
    if (isFunction(store['setState'])) return 'zustand';
  }
  try {
    const marked = Object.getOwnPropertySymbols(target).some(
      (symbol) => symbol.description === 'mobx administration',
    );
    if (marked) return 'mobx';
  } catch {
    // Exotic objects: treat as generic.
  }
  return 'generic';
}

/** The stores a page registered, readable by path. Lives in the page's main world (ADR-0007). */
export class StateRegistry {
  readonly #stores = new Map<string, Entry>();

  /** Register (or replace) a store; returns the undo. */
  register(name: string, target: unknown, options: RegisterOptions = {}): () => void {
    const key = name.slice(0, 128);
    if (!this.#stores.has(key) && this.#stores.size >= MAX_STORES) return () => undefined;
    this.#stores.get(key)?.unsubscribe();
    const entry = this.#entryFor(key, target, options);
    this.#stores.set(key, entry);
    return () => {
      if (this.#stores.get(key) !== entry) return;
      entry.unsubscribe();
      this.#stores.delete(key);
    };
  }

  /** Count one update of a store that reports them itself (devtools `connect().send`). */
  noteUpdate(name: string): void {
    const entry = this.#stores.get(name);
    if (entry) entry.updates = (entry.updates ?? 0) + 1;
  }

  list(): StoreInfo[] {
    return [...this.#stores.values()].map(({ name, kind, updates }) =>
      updates === undefined ? { name, kind } : { name, kind, actions: updates },
    );
  }

  read(request: StateReadRequest = {}): StateReadResult | StateFailure {
    const stores = this.list();
    // Nothing registered: listing is fine, asking for a store or a path is not (a wait must not pass on it).
    if (stores.length === 0 && request.store === undefined && (request.path ?? '') === '') {
      return { stores, value: null, truncated: false };
    }
    const entry = this.#pick(request.store);
    if ('error' in entry) return entry;
    let root: unknown;
    try {
      root = entry.read();
    } catch (error) {
      return failure('INTERNAL', `reading store "${entry.name}" failed: ${messageOf(error)}`);
    }
    let value = root;
    if (request.path !== undefined && request.path !== '') {
      const keys = parsePath(request.path);
      if (!keys)
        return failure('INVALID_PARAMS', `malformed path "${request.path}"`, 'Use e.g. orders.items[0].id');
      const found = lookup(root, keys);
      if (!found.found) {
        return failure(
          'NOT_FOUND',
          `no "${request.path}" in store "${entry.name}" (missing below ${found.at})`,
          keyHint(found.keys),
        );
      }
      value = found.value;
    }
    const limits = { ...DEFAULT_LIMITS, maxDepth: request.maxDepth ?? DEFAULT_LIMITS.maxDepth };
    const json = toJson(value, limits);
    return {
      stores,
      store: entry.name,
      ...(request.path === undefined ? {} : { path: request.path }),
      value: json.value,
      truncated: json.truncated,
    };
  }

  dispatch(request: StateDispatchRequest): { readonly dispatched: true } | StateFailure {
    const entry = this.#pick(request.store);
    if ('error' in entry) return entry;
    if (!entry.dispatch) {
      return failure(
        'UNSUPPORTED',
        `store "${entry.name}" (${entry.kind}) takes no actions`,
        'Register it with registerState(name, store, { dispatch }) to make it dispatchable, or act through the UI.',
      );
    }
    try {
      entry.dispatch(request.action);
    } catch (error) {
      return failure('INTERNAL', `dispatch to "${entry.name}" threw: ${messageOf(error)}`);
    }
    return { dispatched: true };
  }

  #pick(name: string | undefined): Entry | StateFailure {
    const first = this.#stores.values().next().value;
    const entry = name === undefined ? first : this.#stores.get(name);
    if (entry) return entry;
    const names = [...this.#stores.keys()];
    return failure(
      'NOT_FOUND',
      name === undefined ? 'this page registered no stores' : `no store "${name}"`,
      names.length === 0
        ? 'Stores appear once the app registers them (docs/state.md).'
        : `Stores: ${names.join(', ')}`,
    );
  }

  #entryFor(name: string, target: unknown, options: RegisterOptions): Entry {
    const kind = options.kind ?? detectKind(target);
    const store = target as Store;
    const read =
      kind === 'redux' || kind === 'zustand'
        ? () => (store['getState'] as () => unknown)()
        : isFunction(target)
          ? () => target()
          : () => target;
    const own = kind === 'redux' ? (store['dispatch'] as (action: unknown) => unknown) : undefined;
    const entry: Entry = {
      name,
      kind,
      read,
      dispatch: options.dispatch ?? own,
      updates: undefined,
      unsubscribe: () => undefined,
    };
    if (kind !== 'redux' && kind !== 'zustand') return entry;
    entry.updates = 0;
    try {
      const unsubscribe = (store['subscribe'] as (listener: () => void) => unknown)(() => {
        entry.updates = (entry.updates ?? 0) + 1;
      });
      if (isFunction(unsubscribe)) {
        entry.unsubscribe = () => {
          unsubscribe();
        };
      }
    } catch {
      // A store whose subscribe fails is still readable; it just reports no update count.
      entry.updates = undefined;
    }
    return entry;
  }
}

function failure(code: string, message: string, hint?: string): StateFailure {
  return { error: hint === undefined ? { code, message } : { code, message, hint } };
}

function keyHint(keys: readonly string[]): string | undefined {
  return keys.length === 0 ? undefined : `Keys there: ${keys.join(', ')}`;
}

function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unprintable error';
  }
}
