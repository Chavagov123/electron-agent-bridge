import { CLICKABLE_QUERY } from '../agent/clickable-query.js';

/** Listener types that make an element something a user clicks (press-only menus use the down events). */
const CLICK_TYPES = new Set(['click', 'dblclick', 'mousedown', 'pointerdown']);
/** React props that do the same (React listens at its root, not on the element). */
const REACT_CLICK_PROPS = ['onClick', 'onDoubleClick', 'onMouseDown', 'onPointerDown'];

type Page = Window & typeof globalThis;
type Listen = EventTarget['addEventListener'];
/** Per element: the click listeners it has, by type and capture flag (as the DOM tells them apart). */
type Listeners = WeakMap<object, Map<string, Set<unknown>>>;

/**
 * Remember which elements have click listeners, so snapshots can give role-less clickable elements a
 * ref. The isolated-world agent cannot see the page's listeners; it asks by dispatching a cancelable
 * {@link CLICKABLE_QUERY} event at the element, which this hook cancels when the element is clickable
 * (a query at the document only tells the agent that the hook is there). The query never reaches the
 * page's own listeners. `addEventListener` and `removeEventListener` keep their behaviour: the
 * wrappers record, then delegate. Listeners that remove themselves (`once`, an abort signal) are not
 * seen going.
 */
export function installClickTracking(page: Page): void {
  // Not a browser page (no DOM): nothing to track.
  if (typeof (page as Partial<Page>).Element !== 'function') return;
  const proto = ownerOf(page.Element.prototype, 'addEventListener');
  if (proto === undefined) return;
  // The window's own method, taken before wrapping (in browsers it is the same function).
  const listen = page.addEventListener.bind(page);
  const listeners: Listeners = new WeakMap();
  const tracked = (method: string, add: boolean): void => {
    const descriptor = Object.getOwnPropertyDescriptor(proto, method);
    const original = descriptor?.value as Listen | undefined;
    if (descriptor === undefined || typeof original !== 'function') return;
    const wrapper = function (this: EventTarget, ...args: Parameters<Listen>): void {
      if (CLICK_TYPES.has(args[0]) && args[1] != null && this instanceof page.Element) {
        record(listeners, this, args, add);
      }
      original.apply(this, args);
    };
    Object.defineProperty(wrapper, 'name', { value: method });
    Object.defineProperty(proto, method, { ...descriptor, value: wrapper });
  };
  tracked('addEventListener', true);
  tracked('removeEventListener', false);
  listen(
    CLICKABLE_QUERY,
    (event) => {
      event.stopImmediatePropagation();
      // The element asked about, also inside a shadow root (the query is composed).
      const target = event.composedPath()[0] ?? event.target;
      if (target === page.document || (target instanceof page.Element && clickable(target, listeners))) {
        event.preventDefault();
      }
    },
    true,
  );
}

function record(
  listeners: Listeners,
  el: Element,
  [type, listener, options]: Parameters<Listen>,
  add: boolean,
) {
  const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
  let byKey = listeners.get(el);
  if (byKey === undefined) {
    if (!add) return;
    byKey = new Map();
    listeners.set(el, byKey);
  }
  const key = `${type} ${String(capture)}`;
  const set = byKey.get(key) ?? new Set();
  byKey.set(key, set);
  if (add) set.add(listener);
  else set.delete(listener);
}

/** The prototype in `start`'s chain that defines `name` (EventTarget.prototype in browsers). */
function ownerOf(start: object, name: string): object | undefined {
  for (
    let proto: object | null = start;
    proto !== null;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    if (Object.prototype.hasOwnProperty.call(proto, name)) return proto;
  }
  return undefined;
}

function clickable(el: Element, listeners: Listeners): boolean {
  if ((el as HTMLElement).onclick != null) return true;
  for (const set of listeners.get(el)?.values() ?? []) if (set.size > 0) return true;
  const fields = el as unknown as Record<string, unknown>;
  for (const key of Object.keys(el)) {
    if (!key.startsWith('__reactProps$')) continue;
    const props = fields[key] as Record<string, unknown> | null | undefined;
    return REACT_CLICK_PROPS.some((name) => typeof props?.[name] === 'function');
  }
  return false;
}
