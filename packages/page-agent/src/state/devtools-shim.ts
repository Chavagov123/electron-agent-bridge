import type { StateRegistry } from './registry.js';

type Enhancer = (next: CreateStore) => CreateStore;
type CreateStore = (...args: unknown[]) => Record<string, unknown>;
type Listener = (message: unknown) => void;

interface DevtoolsOptions {
  readonly name?: unknown;
}

const EXTENSION = '__REDUX_DEVTOOLS_EXTENSION__';
const COMPOSE = '__REDUX_DEVTOOLS_EXTENSION_COMPOSE__';

function compose(...functions: Enhancer[]): Enhancer {
  return (next) => functions.reduceRight((store, enhancer) => enhancer(store), next);
}

/**
 * Opt-in (`state.devtoolsShim`): stand in for the Redux DevTools extension so stores built with
 * devtools support register themselves — Redux / RTK (`devTools: true`, the default) through the
 * enhancer and compose functions, Zustand's `devtools` middleware and other libraries through
 * `connect()`. Like the extension, the enhancer sees the store below middleware, so thunks are not
 * visible, the plain actions they dispatch are.
 *
 * Where the real extension is installed (apps in development load it), its enhancer and compose are
 * wrapped instead: Redux stores register and the extension keeps working; `connect()` is its own. An
 * extension that defines its globals after this hook replaces the shim and is wrapped the same way.
 */
export function installDevtoolsShim(registry: StateRegistry, page: Record<string, unknown>): void {
  let count = 0;
  const nameOf = (options: DevtoolsOptions | undefined, fallback: string): string => {
    count++;
    return typeof options?.name === 'string' && options.name !== ''
      ? options.name
      : `${fallback}${count > 1 ? count : ''}`;
  };

  const enhancer =
    (options?: DevtoolsOptions): Enhancer =>
    (next) =>
    (...args) => {
      const store = next(...args);
      registry.register(nameOf(options, 'redux'), store, { kind: 'redux' });
      return store;
    };

  const connect = (options?: DevtoolsOptions) => {
    const name = nameOf(options, 'store');
    const listeners = new Set<Listener>();
    let current: unknown = null;
    registry.register(name, () => current, {
      kind: 'generic',
      // What the extension sends when a user dispatches from its UI; Zustand's middleware applies it.
      dispatch: (action) => {
        // Zustand applies `__setState` without reporting it back through `send`: track it like the extension.
        const next = (action as { type?: unknown; state?: unknown } | null)?.state;
        if (
          (action as { type?: unknown } | null)?.type === '__setState' &&
          typeof next === 'object' &&
          next !== null
        ) {
          current = { ...(current as object | null), ...next };
        }
        for (const listener of listeners) listener({ type: 'ACTION', payload: JSON.stringify(action) });
      },
    });
    return {
      init: (state: unknown) => {
        current = state;
      },
      send: (_action: unknown, state: unknown) => {
        current = state;
        registry.noteUpdate(name);
      },
      subscribe: (listener: Listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      unsubscribe: () => {
        listeners.clear();
      },
      error: () => undefined,
    };
  };

  /** The compose function over `base` (plain compose for the shim, the extension's own otherwise). */
  const composeWith =
    (base: (...args: unknown[]) => unknown) =>
    (...args: unknown[]): unknown => {
      const [first] = args;
      // composeWithDevTools(options) returns a compose; composeWithDevTools(f, g) composes directly.
      if (args.length === 1 && typeof first === 'object' && first !== null) {
        const composeFor = base(first) as (...functions: Enhancer[]) => unknown;
        return (...functions: Enhancer[]) => composeFor(...functions, enhancer(first));
      }
      return base(...args, enhancer());
    };

  const shim = {
    [EXTENSION]: Object.assign((options?: DevtoolsOptions) => enhancer(options), { connect }),
    [COMPOSE]: composeWith((...args) =>
      args.length === 1 && typeof args[0] === 'object' ? compose : compose(...(args as Enhancer[])),
    ),
  };
  const wrap = {
    [EXTENSION]: (real: (options?: DevtoolsOptions) => Enhancer) =>
      Object.assign((options?: DevtoolsOptions) => compose(real(options), enhancer(options)), real),
    [COMPOSE]: composeWith,
  };
  for (const key of [EXTENSION, COMPOSE] as const) {
    const wrapped = (value: unknown): unknown =>
      typeof value === 'function' ? wrap[key](value as never) : value;
    let current = page[key] === undefined ? shim[key] : wrapped(page[key]);
    Object.defineProperty(page, key, {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (value: unknown) => {
        current = wrapped(value);
      },
    });
  }
}
