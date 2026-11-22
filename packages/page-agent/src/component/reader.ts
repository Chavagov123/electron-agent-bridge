import { lookup, parsePath } from '../state/path.js';
import { DEFAULT_LIMITS, toJson } from '../state/serialize.js';

/** What `state.component` asks the page for (protocol 1.1). */
export interface ComponentReadRequest {
  /** Path into the component's `{ props, state, hooks }`, e.g. `state.count` or `hooks[0]`. */
  readonly path?: string;
  /** Which component around the element: 0 is the nearest (default), 1 its parent component… */
  readonly component?: number;
  readonly maxDepth?: number;
}

export type ComponentFramework = 'react' | 'vue';

export type ComponentReadResult =
  | {
      readonly found: true;
      readonly framework: ComponentFramework;
      /** Component names around the element, nearest first. */
      readonly chain: readonly string[];
      readonly name: string;
      readonly value: unknown;
      readonly truncated: boolean;
    }
  | {
      readonly found: false;
      readonly error: { readonly code: string; readonly message: string; readonly hint?: string };
    };

/** Components listed around an element. */
const MAX_CHAIN = 10;
/** Ancestors searched for the framework's handle on a DOM node. */
const MAX_CLIMB = 50;

interface Fiber {
  tag?: number;
  type?: unknown;
  memoizedProps?: unknown;
  memoizedState?: unknown;
  stateNode?: unknown;
  return?: Fiber | null;
  alternate?: Fiber | null;
}

/** Fiber tag of the tree's root; its `stateNode.current` is the committed tree. */
const HOST_ROOT = 3;

interface Component {
  readonly name: string;
  readonly view: () => unknown;
}

/** React fiber tags of components (function, class, forwardRef, memo, simple memo). */
const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);

/**
 * Read the component state behind a DOM element (main world: framework handles on DOM nodes are only
 * visible there). React: the fibers above the element (props, class state, `useState`/`useReducer`
 * hooks in order). Vue 3: the component instances above it (props, setup state, data). Values are
 * copied bounded and JSON-safe; nothing is called but property reads.
 */
export function read(el: Element, request: ComponentReadRequest = {}): ComponentReadResult {
  try {
    const found = reactComponents(el) ?? vueComponents(el);
    if (found === undefined) {
      return failure(
        'NOT_FOUND',
        'no React or Vue component renders this element',
        'Point at an element the app renders with React or Vue 3.',
      );
    }
    const { framework, components } = found;
    const index = request.component ?? 0;
    const component = components[index];
    if (component === undefined) {
      return failure('NOT_FOUND', `only ${components.length} component(s) around this element`);
    }
    let value: unknown = component.view();
    if (request.path !== undefined && request.path !== '') {
      const keys = parsePath(request.path);
      if (keys === undefined)
        return failure('INVALID_PARAMS', `malformed path ${JSON.stringify(request.path)}`);
      const hit = lookup(value, keys);
      if (!hit.found) {
        return failure(
          'NOT_FOUND',
          `no ${JSON.stringify(hit.at)} in ${component.name}`,
          `Keys there: ${hit.keys.slice(0, 20).join(', ')}`,
        );
      }
      value = hit.value;
    }
    const json = toJson(value, { ...DEFAULT_LIMITS, maxDepth: request.maxDepth ?? DEFAULT_LIMITS.maxDepth });
    return {
      found: true,
      framework,
      chain: components.map((entry) => entry.name),
      name: component.name,
      value: json.value,
      truncated: json.truncated,
    };
  } catch (error) {
    return failure(
      'INTERNAL',
      `reading the component failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function failure(code: string, message: string, hint?: string): ComponentReadResult {
  return { found: false, error: { code, message, ...(hint === undefined ? {} : { hint }) } };
}

/** The first own property of the node, or of its nearest ancestor, whose name starts with a prefix. */
function handle(el: Element, prefixes: readonly string[]): unknown {
  let node: Element | null = el;
  for (let depth = 0; node && depth < MAX_CLIMB; depth++, node = node.parentElement) {
    // Own names, enumerable or not: Vue defines its handle non-enumerable.
    for (const key of Object.getOwnPropertyNames(node)) {
      if (prefixes.some((prefix) => key.startsWith(prefix)))
        return (node as unknown as Record<string, unknown>)[key];
    }
  }
  return undefined;
}

function reactComponents(el: Element): { framework: 'react'; components: Component[] } | undefined {
  const handleFiber = handle(el, ['__reactFiber$', '__reactInternalInstance$']) as Fiber | undefined;
  if (handleFiber === undefined) return undefined;
  const host = committed(handleFiber);
  const components: Component[] = [];
  for (
    let fiber: Fiber | null | undefined = host;
    fiber && components.length < MAX_CHAIN;
    fiber = fiber.return
  ) {
    if (fiber.tag === undefined || !COMPONENT_TAGS.has(fiber.tag)) continue;
    const current = fiber;
    components.push({ name: reactName(current.type), view: () => reactView(current) });
  }
  return components.length === 0 ? undefined : { framework: 'react', components };
}

/**
 * The fiber of the committed tree: React keeps two fibers per element and the DOM node may point at
 * the one from an earlier render. Its root says which tree is current.
 */
function committed(fiber: Fiber): Fiber {
  let top: Fiber = fiber;
  for (let depth = 0; top.return && depth < 10_000; depth++) top = top.return;
  const root = top.tag === HOST_ROOT ? (top.stateNode as { current?: unknown } | null) : null;
  if (root?.current === undefined || root.current === top) return fiber;
  return fiber.alternate ?? fiber;
}

function reactName(type: unknown): string {
  const named = type as {
    displayName?: unknown;
    name?: unknown;
    render?: { name?: unknown };
    type?: unknown;
  } | null;
  if (named === null || (typeof named !== 'object' && typeof named !== 'function')) return 'Anonymous';
  for (const candidate of [named.displayName, named.name, named.render?.name]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return named.type === undefined ? 'Anonymous' : reactName(named.type);
}

function reactView(fiber: Fiber): unknown {
  const props = withoutChildren(fiber.memoizedProps);
  if (fiber.tag === 1) return { props, state: (fiber.stateNode as { state?: unknown } | null)?.state };
  // Function components: the hook list, in call order; state and reducer hooks have a queue.
  const hooks: unknown[] = [];
  let others = 0;
  for (
    let hook = fiber.memoizedState as { memoizedState?: unknown; queue?: unknown; next?: unknown } | null;
    hook && hooks.length + others < 100;
    hook = hook.next as typeof hook
  ) {
    if (hook.queue !== null && hook.queue !== undefined) hooks.push(hook.memoizedState);
    else others++;
  }
  return { props, hooks, ...(others > 0 ? { otherHooks: others } : {}) };
}

function withoutChildren(props: unknown): unknown {
  if (props === null || typeof props !== 'object' || !('children' in props)) return props;
  const { children, ...rest } = props as Record<string, unknown>;
  return children === undefined ? rest : { ...rest, children: '[children]' };
}

interface VueInstance {
  type?: { name?: unknown; __name?: unknown };
  props?: unknown;
  setupState?: unknown;
  data?: unknown;
  parent?: VueInstance | null;
}

function vueComponents(el: Element): { framework: 'vue'; components: Component[] } | undefined {
  const nearest = handle(el, ['__vueParentComponent']) as VueInstance | undefined;
  if (nearest === undefined) return undefined;
  const components: Component[] = [];
  for (
    let instance: VueInstance | null | undefined = nearest;
    instance && components.length < MAX_CHAIN;
    instance = instance.parent
  ) {
    const current = instance;
    const name = [current.type?.name, current.type?.__name].find(
      (candidate) => typeof candidate === 'string' && candidate !== '',
    );
    components.push({
      name: typeof name === 'string' ? name : 'Anonymous',
      view: () => ({ props: current.props, state: { ...plain(current.setupState), ...plain(current.data) } }),
    });
  }
  return { framework: 'vue', components };
}

/** Own enumerable keys of a (possibly reactive) object, without Vue's internal ones. */
function plain(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (!key.startsWith('__v_') && !key.startsWith('$')) out[key] = (value as Record<string, unknown>)[key];
  }
  return out;
}
