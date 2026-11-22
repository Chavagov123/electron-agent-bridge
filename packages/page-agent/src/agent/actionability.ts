import type { Locator } from '@eab/core';

import { accessibleName } from './accname.js';
import { AgentFailure } from './failure.js';
import { resolveInDom, resolveLocator, type FindContext } from './find.js';
import { parseRef, type RefTable } from './refs.js';
import { isHidden, roleOf } from './semantics.js';

/** An element ready for input, with the point to aim at in top-level viewport CSS pixels. */
export interface ActionTarget {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly tag: string;
  readonly inputType: string | undefined;
  readonly x: number;
  readonly y: number;
  readonly editable: boolean;
  /** In a `draggable="true"` element: HTML5 drag and drop, which CDP mouse events do not start. */
  readonly draggable: boolean;
  /** The locator's ref was stale and was healed to a unique element with the same role and name. */
  readonly healed: boolean;
}

export interface Requirements {
  /** Fail with DISABLED when the element is disabled (not for hover or scroll). */
  readonly enabled: boolean;
  /** Check that the element actually receives a click at its centre (not covered). */
  readonly hitTest: boolean;
  /**
   * `false`: the element may be hidden; it is only resolved (whole DOM) and checked for enabled, with no
   * point to aim at (`x`/`y` are 0). For targets set through CDP rather than input, like file inputs.
   */
  readonly visible?: boolean;
}

export interface ActionabilityContext extends FindContext {
  readonly refs: RefTable;
}

/**
 * Resolve exactly one element: several matches without `nth` is AMBIGUOUS. A stale ref (element gone)
 * is healed when exactly one element has the role and name the ref had and no other gone ref had them
 * (so a per-row control is never swapped for another row's); otherwise STALE_REF.
 */
export function resolveOne(
  locator: Locator,
  context: ActionabilityContext,
  resolve: (locator: Locator, context: FindContext) => Element[] = resolveLocator,
): { el: Element; healed: boolean } {
  const matches = resolve(locator, context);
  if (matches.length === 1 && matches[0]) return { el: matches[0], healed: false };
  if (matches.length > 1) {
    throw new AgentFailure(
      'AMBIGUOUS',
      `${matches.length} elements match; add nth, narrow the name, or use a ref`,
    );
  }
  if (locator.ref === undefined) throw new AgentFailure('NOT_FOUND', 'no element matches');
  const id = parseRef(locator.ref);
  const known = id === undefined ? undefined : context.refs.lastKnown(id);
  if (known && context.refs.goneWith(known.role, known.name) === 1) {
    const twins = resolve({ role: known.role, name: known.name, exact: true }, context);
    if (twins.length === 1 && twins[0]) return { el: twins[0], healed: true };
  }
  throw new AgentFailure('STALE_REF', `${locator.ref} no longer exists; take a new snapshot`);
}

/** Locator lookups kept per page while the DOM is unchanged (auto-wait retries, consecutive steps). */
const MEMO_SIZE = 200;
const memos = new WeakMap<
  FindContext,
  Map<string, { readonly generation: number; readonly el: WeakRef<Element> }>
>();

/**
 * {@link resolveLocator}, reusing the last unique match of the same locator while the DOM has not changed
 * since (its generation is the same) and the element is still attached. Refs resolve directly anyway.
 */
function memoized(locator: Locator, context: FindContext): Element[] {
  const generation = context.generation?.();
  if (generation === undefined || locator.ref !== undefined) return resolveLocator(locator, context);
  let memo = memos.get(context);
  if (!memo) {
    memo = new Map();
    memos.set(context, memo);
  }
  const key = JSON.stringify(locator);
  const hit = memo.get(key);
  const cached = hit?.generation === generation ? hit.el.deref() : undefined;
  if (cached?.isConnected === true) return [cached];
  const found = resolveLocator(locator, context);
  memo.delete(key);
  const [only] = found;
  if (found.length === 1 && only !== undefined) {
    memo.set(key, { generation, el: new WeakRef(only) });
    if (memo.size > MEMO_SIZE) memo.delete(memo.keys().next().value ?? key);
  }
  return found;
}

/** Check actionability: attached, visible, enabled, in view, stable, and not covered. */
export async function actionTarget(
  locator: Locator,
  requirements: Requirements,
  context: ActionabilityContext,
): Promise<ActionTarget> {
  if (requirements.visible === false) {
    const { el, healed } = resolveOne(locator, context, resolveInDom);
    if (requirements.enabled && isDisabled(el)) throw new AgentFailure('DISABLED', 'the element is disabled');
    return describe(el, { x: 0, y: 0 }, healed, context.refs);
  }
  const { el, healed } = resolveOne(locator, context, memoized);
  const win = assertUsable(el, requirements);
  const { x, y } = await stableCentre(el, win);
  if (requirements.hitTest) assertReceivesClick(el, x, y);
  const offset = frameOffset(win);
  return describe(el, { x: x + offset.x, y: y + offset.y }, healed, context.refs);
}

function describe(
  el: Element,
  point: { x: number; y: number },
  healed: boolean,
  refs: RefTable,
): ActionTarget {
  const role = roleOf(el) ?? 'generic';
  return {
    ref: `e${refs.refOf(el)}`,
    role,
    name: accessibleName(el, role),
    tag: el.tagName.toLowerCase(),
    inputType: el.tagName === 'INPUT' ? (el as HTMLInputElement).type : undefined,
    x: point.x,
    y: point.y,
    editable: isEditable(el),
    draggable: el.closest('[draggable="true"]') !== null,
    healed,
  };
}

/** Visible, enabled if required, and in a window. */
function assertUsable(el: Element, requirements: Requirements): Window {
  if (isHidden(el)) throw new AgentFailure('HIDDEN', 'the element is not visible');
  if (requirements.enabled && isDisabled(el)) throw new AgentFailure('DISABLED', 'the element is disabled');
  const win = el.ownerDocument.defaultView;
  if (!win) throw new AgentFailure('DETACHED', 'the element is not in a window');
  return win;
}

/**
 * Scroll into view, then the centre point once the element has stopped moving: unchanged over two
 * frames, since one frame can fall inside a pause of a scroll or animation still in flight.
 */
async function stableCentre(el: Element, win: Window): Promise<{ x: number; y: number }> {
  if (!inViewport(el, win)) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  let rect = el.getBoundingClientRect();
  for (let frame = 0; frame < 2; frame++) {
    await nextFrame(win);
    if (!el.isConnected) throw new AgentFailure('DETACHED', 'the element was removed');
    const next = el.getBoundingClientRect();
    if (!sameRect(rect, next)) throw new AgentFailure('UNSTABLE', 'the element is still moving');
    rect = next;
  }
  if (rect.width === 0 || rect.height === 0) throw new AgentFailure('HIDDEN', 'the element has no size');
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (x < 0 || y < 0 || x > win.innerWidth || y > win.innerHeight) {
    throw new AgentFailure('OFF_SCREEN', 'the element cannot be scrolled into view');
  }
  return { x, y };
}

/** Disabled form controls (including inside a disabled fieldset) or `aria-disabled`. */
export function isDisabled(el: Element): boolean {
  if (el.getAttribute('aria-disabled') === 'true') return true;
  try {
    return el.matches(':disabled');
  } catch {
    return false;
  }
}

/** Text inputs, textareas and contenteditable elements that are not read-only. */
export function isEditable(el: Element): boolean {
  if (el.tagName === 'TEXTAREA') return !(el as HTMLTextAreaElement).readOnly;
  if (el.tagName === 'INPUT') {
    const input = el as HTMLInputElement;
    const textual = ![
      'checkbox',
      'radio',
      'button',
      'submit',
      'reset',
      'file',
      'image',
      'range',
      'color',
      'hidden',
    ].includes(input.type);
    return textual && !input.readOnly;
  }
  return (el as HTMLElement).isContentEditable;
}

function assertReceivesClick(el: Element, x: number, y: number): void {
  const hit = deepElementFromPoint(el.ownerDocument, x, y);
  if (!hit) throw new AgentFailure('OFF_SCREEN', 'nothing is rendered at the element position');
  if (composedContains(el, hit)) return;
  // A label covering its own (often visually hidden) control forwards the click to it.
  const label = hit.closest('label');
  if (label?.control === el) return;
  const role = roleOf(hit);
  const description = `${hit.tagName.toLowerCase()}${role ? ` (${role} "${accessibleName(hit, role)}")` : ''}`;
  throw new AgentFailure('OCCLUDED', `the element is covered by ${description}`);
}

function deepElementFromPoint(doc: Document, x: number, y: number): Element | null {
  let hit = doc.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit;
}

/** `ancestor` contains `node`, crossing shadow-root boundaries. */
function composedContains(ancestor: Element, node: Node): boolean {
  for (let current: Node | null = node; current;) {
    if (current === ancestor) return true;
    const parent: Node | null = current.parentNode;
    current = parent?.nodeType === 11 ? (parent as ShadowRoot).host : parent;
  }
  return false;
}

function inViewport(el: Element, win: Window): boolean {
  const rect = el.getBoundingClientRect();
  return rect.top >= 0 && rect.left >= 0 && rect.bottom <= win.innerHeight && rect.right <= win.innerWidth;
}

function sameRect(a: DOMRect, b: DOMRect): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/** Offset of a (same-origin) frame's viewport within the top-level viewport. */
function frameOffset(win: Window): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let current: Window | null = win; current?.frameElement;) {
    const frame: Element = current.frameElement;
    const rect = frame.getBoundingClientRect();
    x += rect.left + frame.clientLeft;
    y += rect.top + frame.clientTop;
    current = frame.ownerDocument.defaultView;
  }
  return { x, y };
}

/** One rendered frame later; falls back to a timer where frames are throttled (hidden windows). */
export function nextFrame(win: Window): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    win.requestAnimationFrame(finish);
    win.setTimeout(finish, 50);
  });
}
