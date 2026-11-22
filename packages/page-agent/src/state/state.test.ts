import { describe, expect, it } from 'vitest';

import { installDevtoolsShim } from './devtools-shim.js';
import { lookup, parsePath } from './path.js';
import { StateRegistry, type StateFailure, type StateReadResult } from './registry.js';
import { toJson } from './serialize.js';
import { stateHookSource } from './state-hook.js';

function reduxLike(initial: Record<string, unknown>) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch: (action: { type: string; by?: number }) => {
      if (action.type === 'boom') throw new Error('reducer failed');
      if (action.type === 'add') state = { ...state, count: Number(state['count']) + (action.by ?? 1) };
      for (const listener of listeners) listener();
      return action;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const read = (registry: StateRegistry, request = {}) => registry.read(request) as StateReadResult;
const failed = (result: unknown) => (result as StateFailure).error;

describe('state serializer', () => {
  it('describes what JSON cannot hold and stays within its bounds', () => {
    const cyclic: Record<string, unknown> = { id: 1 };
    cyclic['self'] = cyclic;
    const hostile = Object.defineProperty({}, 'bad', {
      enumerable: true,
      get: () => {
        throw new Error('no');
      },
    });
    const { value, truncated } = toJson({
      cyclic,
      when: new Date(0),
      map: new Map([['a', 1]]),
      set: new Set([1]),
      fn: function save() {
        return 1;
      },
      big: 10n,
      sym: Symbol('s'),
      nan: Number.NaN,
      error: new TypeError('x'),
      re: /a/g,
      hostile,
      gone: undefined,
      list: [undefined, 1],
    });
    expect(truncated).toBe(false);
    expect(value).toEqual({
      cyclic: { id: 1, self: '[circular]' },
      when: '1970-01-01T00:00:00.000Z',
      map: { '[Map]': [['a', 1]] },
      set: { '[Set]': [1] },
      fn: '[function save]',
      big: '10n',
      sym: 'Symbol(s)',
      nan: 'NaN',
      error: { name: 'TypeError', message: 'x' },
      re: '/a/g',
      hostile: { bad: '[unreadable]' },
      list: [null, 1],
    });
    const limits = { maxDepth: 2, maxKeys: 2, maxArrayItems: 2, maxStringChars: 3, maxNodes: 100 };
    expect(toJson({ a: { b: { c: 1 } }, s: 'long', x: 1 }, limits)).toEqual({
      value: { a: { b: '[object]' }, s: 'lon…', '…': '1 more keys' },
      truncated: true,
    });
    expect(toJson([1, 2, 3], limits).value).toEqual([1, 2, '… 1 more']);
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(toJson({ draft: proxy, ok: 1 }).value).toEqual({ draft: '[unreadable]', ok: 1 });
    expect(toJson(new Array(50).fill({}), { ...limits, maxArrayItems: 50, maxNodes: 10 }).truncated).toBe(
      true,
    );
  });
});

describe('state paths', () => {
  it('parses dots, indexes and quoted keys, and explains misses', () => {
    expect(parsePath('orders.items[0].id')).toEqual(['orders', 'items', '0', 'id']);
    expect(parsePath('byId["a.b"].name')).toEqual(['byId', 'a.b', 'name']);
    expect(parsePath("x['q']")).toEqual(['x', 'q']);
    expect(parsePath('a[')).toBeUndefined();
    const state = { orders: { items: [{ id: 7 }] }, map: new Map([['k', 1]]) };
    expect(lookup(state, ['orders', 'items', '0', 'id'])).toEqual({ found: true, value: 7 });
    expect(lookup(state, ['map', 'k'])).toEqual({ found: true, value: 1 });
    expect(lookup(state, ['orders', 'nope'])).toEqual({ found: false, at: 'orders', keys: ['items'] });
    expect(lookup(state, ['orders', 'items', '0', 'id', 'deeper'])).toMatchObject({ found: false });
  });
});

describe('StateRegistry', () => {
  it('detects Redux, Zustand, MobX and generic stores, and counts updates', () => {
    const registry = new StateRegistry();
    const redux = reduxLike({ count: 1 });
    registry.register('cart', redux);
    const zustandState = { open: false };
    registry.register('ui', {
      getState: () => zustandState,
      setState: () => undefined,
      subscribe: () => () => undefined,
    });
    const mobx = Object.defineProperty({ todos: ['a'] }, Symbol('mobx administration'), { value: {} });
    registry.register('todos', mobx);
    registry.register('prefs', () => ({ theme: 'dark' }));
    redux.dispatch({ type: 'add', by: 2 });
    expect(registry.list()).toEqual([
      { name: 'cart', kind: 'redux', actions: 1 },
      { name: 'ui', kind: 'zustand', actions: 0 },
      { name: 'todos', kind: 'mobx' },
      { name: 'prefs', kind: 'generic' },
    ]);
    expect(read(registry)).toMatchObject({ store: 'cart', value: { count: 3 } });
    expect(read(registry, { store: 'prefs', path: 'theme' })).toMatchObject({ value: 'dark', path: 'theme' });
    expect(read(registry, { store: 'todos', path: 'todos[0]' }).value).toBe('a');
  });

  it('reports unknown stores, missing paths and broken stores as failures, not throws', () => {
    const registry = new StateRegistry();
    expect(read(registry)).toEqual({ stores: [], value: null, truncated: false });
    // Asking for a store or a path before any exists is a miss (a wait must not pass on it).
    expect(failed(registry.read({ store: 'cart' }))).toMatchObject({ code: 'NOT_FOUND' });
    expect(failed(registry.read({ path: 'user' }))).toMatchObject({ code: 'NOT_FOUND' });
    expect(failed(registry.dispatch({ action: {} }))).toMatchObject({ code: 'NOT_FOUND' });
    registry.register('cart', reduxLike({ count: 1 }));
    registry.register('broken', () => {
      throw new Error('getter failed');
    });
    expect(failed(registry.read({ store: 'nope' }))).toMatchObject({
      code: 'NOT_FOUND',
      hint: 'Stores: cart, broken',
    });
    expect(failed(registry.read({ path: 'count.x' }))).toMatchObject({ code: 'NOT_FOUND' });
    expect(failed(registry.read({ path: 'a[' }))).toMatchObject({ code: 'INVALID_PARAMS' });
    expect(failed(registry.read({ store: 'broken' }))).toMatchObject({ code: 'INTERNAL' });
  });

  it('dispatches to Redux stores and to stores registered with a dispatch function', () => {
    const registry = new StateRegistry();
    registry.register('cart', reduxLike({ count: 1 }));
    const received: unknown[] = [];
    registry.register('custom', () => ({}), { dispatch: (action) => received.push(action) });
    registry.register('plain', { a: 1 });
    expect(registry.dispatch({ store: 'cart', action: { type: 'add' } })).toEqual({ dispatched: true });
    expect(read(registry).value).toEqual({ count: 2 });
    expect(registry.dispatch({ store: 'custom', action: { type: 'x' } })).toEqual({ dispatched: true });
    expect(received).toEqual([{ type: 'x' }]);
    expect(failed(registry.dispatch({ store: 'plain', action: {} }))).toMatchObject({ code: 'UNSUPPORTED' });
    expect(failed(registry.dispatch({ store: 'cart', action: { type: 'boom' } }))).toMatchObject({
      code: 'INTERNAL',
    });
  });

  it('replaces a store registered again under its name, and unregisters only its own entry', () => {
    const registry = new StateRegistry();
    const first = registry.register('s', () => 1);
    registry.register('s', () => 2);
    first();
    expect(read(registry).value).toBe(2);
    for (let index = 0; index < 60; index++) registry.register(`x${index}`, {});
    expect(registry.list()).toHaveLength(50);
  });
});

describe('devtools shim', () => {
  it('registers stores built through the enhancer, compose and connect, only without a real extension', () => {
    const registry = new StateRegistry();
    const page: Record<string, unknown> = {};
    installDevtoolsShim(registry, page);
    const createStore = (...args: unknown[]) => reduxLike(args[0] as Record<string, unknown>);
    type Compose = (
      ...args: unknown[]
    ) => (...enhancers: unknown[]) => (next: typeof createStore) => typeof createStore;
    // Redux Toolkit: composeWithDevTools(options)(...enhancers)
    const rtk = (page['__REDUX_DEVTOOLS_EXTENSION_COMPOSE__'] as Compose)({ name: 'cart', trace: true })();
    rtk(createStore)({ count: 1 });
    // Plain Redux: createStore(reducer, window.__REDUX_DEVTOOLS_EXTENSION__())
    const extension = page['__REDUX_DEVTOOLS_EXTENSION__'] as ((
      options?: object,
    ) => (next: typeof createStore) => typeof createStore) & {
      connect: (options?: object) => {
        init: (state: unknown) => void;
        send: (action: unknown, state: unknown) => void;
        subscribe: (listener: (message: unknown) => void) => () => void;
      };
    };
    extension()(createStore)({ count: 5 });
    (
      page['__REDUX_DEVTOOLS_EXTENSION_COMPOSE__'] as (
        ...args: unknown[]
      ) => (next: typeof createStore) => typeof createStore
    )()(createStore)({});
    // Zustand's devtools middleware
    const connection = extension.connect({ name: 'ui' });
    const messages: unknown[] = [];
    connection.subscribe((message) => messages.push(message));
    connection.init({ open: false });
    connection.send({ type: 'toggle' }, { open: true });
    expect(registry.list().map(({ name, kind, actions }) => [name, kind, actions])).toEqual([
      ['cart', 'redux', 0],
      ['redux2', 'redux', 0],
      ['redux3', 'redux', 0],
      ['ui', 'generic', 1],
    ]);
    expect(read(registry, { store: 'ui' }).value).toEqual({ open: true });
    registry.dispatch({ store: 'ui', action: { type: 'reset' } });
    expect(messages).toEqual([{ type: 'ACTION', payload: '{"type":"reset"}' }]);
  });

  it('wraps a real extension, present or defined later, so its stores register and it keeps working', () => {
    type Enhancer = (next: CreateStore) => CreateStore;
    type CreateStore = (...args: unknown[]) => Record<string, unknown>;
    const seen: string[] = [];
    /** Like the real extension: its enhancer marks the store it builds. */
    const realEnhancer =
      (label: string): Enhancer =>
      (next) =>
      (...args) => {
        seen.push(label);
        return { ...next(...args), lifted: true };
      };
    const realCompose =
      (options: { name: string }) =>
      (...functions: Enhancer[]) =>
      (next: CreateStore) =>
        [...functions, realEnhancer(options.name)].reduceRight((store, enhancer) => enhancer(store), next);
    const createStore: CreateStore = (...args) => reduxLike(args[0] as Record<string, unknown>);

    const registry = new StateRegistry();
    const page: Record<string, unknown> = { __REDUX_DEVTOOLS_EXTENSION_COMPOSE__: realCompose };
    installDevtoolsShim(registry, page);
    const composeEnhancers = (page['__REDUX_DEVTOOLS_EXTENSION_COMPOSE__'] as typeof realCompose)({
      name: 'main',
    });
    const store = composeEnhancers()(createStore)({ count: 1 });
    expect(store['lifted']).toBe(true);
    // An extension arriving after the hook replaces the shim and is wrapped too.
    const connect = () => 'connected';
    page['__REDUX_DEVTOOLS_EXTENSION__'] = Object.assign(() => realEnhancer('late'), { connect });
    const extension = page['__REDUX_DEVTOOLS_EXTENSION__'] as (() => Enhancer) & { connect: () => string };
    extension()(createStore)({ count: 2 });
    expect(extension.connect()).toBe('connected');
    expect(seen).toEqual(['main', 'late']);
    expect(registry.list().map(({ name }) => name)).toEqual(['main', 'redux2']);
    expect(read(registry, { store: 'main' }).value).toEqual({ count: 1 });
  });
});

describe('state hook bundle', () => {
  function page(top: 'self' | 'other') {
    const sandbox: Record<string, unknown> = {};
    sandbox['window'] = sandbox;
    sandbox['globalThis'] = sandbox;
    sandbox['top'] = top === 'self' ? sandbox : {};
    return sandbox;
  }

  /** Evaluate a script with this sandbox as its `window` and `globalThis`, as a page would. */
  function run(source: string, sandbox: Record<string, unknown>): void {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- evaluating the generated bundle is the test
    (new Function('globalThis', 'window', source) as (...args: unknown[]) => void)(sandbox, sandbox);
  }
  const registryOf = (sandbox: Record<string, unknown>) =>
    (sandbox as Record<symbol, StateRegistry | undefined>)[Symbol.for('electron-agent-bridge.v1.state')];

  it('installs the registry once in a top-level page, never in a frame, and the shim only on request', () => {
    const top = page('self');
    run(stateHookSource({ devtoolsShim: true }), top);
    run(stateHookSource(), top);
    const registry = registryOf(top);
    expect(registry?.list()).toEqual([]);
    expect(Object.keys(top)).toEqual([
      'window',
      'globalThis',
      'top',
      '__REDUX_DEVTOOLS_EXTENSION__',
      '__REDUX_DEVTOOLS_EXTENSION_COMPOSE__',
    ]);
    const plain = page('self');
    run(stateHookSource(), plain);
    expect(Object.keys(plain)).toEqual(['window', 'globalThis', 'top']);
    const frame = page('other');
    run(stateHookSource(), frame);
    expect(registryOf(frame)).toBeUndefined();
  });
});

describe('stores registered before the hook', () => {
  it('are taken over when the hook installs, and their undo still works', () => {
    const sandbox: Record<string | symbol, unknown> = {};
    sandbox['window'] = sandbox;
    sandbox['top'] = sandbox;
    const pending = [
      { name: 'early', store: () => ({ ready: true }), options: {} },
      { name: 'removed', store: () => 1, options: {} },
    ] as { name: string; store: unknown; options: object; undo?: () => void }[];
    sandbox[Symbol.for('electron-agent-bridge.v1.state-pending')] = pending;
    const [, removed] = pending;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- evaluating the generated bundle is the test
    (new Function('globalThis', 'window', stateHookSource()) as (...args: unknown[]) => void)(
      sandbox,
      sandbox,
    );
    const registry = sandbox[Symbol.for('electron-agent-bridge.v1.state')] as StateRegistry;
    expect(registry.list().map((store) => store.name)).toEqual(['early', 'removed']);
    expect(pending).toEqual([]);
    removed?.undo?.();
    expect(registry.list().map((store) => store.name)).toEqual(['early']);
  });
});
