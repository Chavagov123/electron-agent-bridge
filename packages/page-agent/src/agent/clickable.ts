import { pageListensForClicks } from './clickable-query.js';
import { isInteractive, roleOf } from './semantics.js';

/**
 * The role snapshots give an element that has none of its own but that a user can evidently click:
 * custom menus, cards and toolbars built from plain `div`s. Its name comes from its content.
 */
export const CLICKABLE = 'clickable';

/** How an element shows in snapshots: its role, and whether it is one line (its content is its name). */
export interface SnapshotRole {
  readonly role: string;
  readonly leaf: boolean;
}

/** The role an element is shown and found with: its ARIA role, else `clickable` when it is one. */
export function snapshotRoleOf(el: Element): string | undefined {
  return roleOf(el) ?? clickableOf(el)?.role;
}

/**
 * The role-less element a user clicks, and whether it stands alone:
 * - one with an inline `onclick` handler, or where the pointer cursor starts (its parent does not have
 *   it: `cursor` is inherited, so only the outermost element of a clickable area counts) — visible
 *   promises of a click area, kept even when they hold other controls (a card with buttons);
 * - one the page's own code listens to for clicks (asked of the main-world hook: listeners, `onclick`
 *   properties and React handlers are invisible from here), unless it wraps other things to operate:
 *   such listeners are mostly delegation or close-on-click, and the controls inside carry the refs.
 * Never the page itself, nor a `<label>` whose control is shown on its own.
 */
export function clickableOf(el: Element): SnapshotRole | undefined {
  const doc = el.ownerDocument;
  if (el === doc.body || el === doc.documentElement) return undefined;
  if (el.tagName === 'LABEL' && (el as HTMLLabelElement).control) return undefined;
  if (looksClickable(el)) return { role: CLICKABLE, leaf: !holdsControls(el) };
  return pageListensForClicks(el) && !holdsControls(el) ? { role: CLICKABLE, leaf: true } : undefined;
}

function looksClickable(el: Element): boolean {
  return (el as HTMLElement).onclick != null || pointerStartsHere(el);
}

function pointerStartsHere(el: Element): boolean {
  const win = el.ownerDocument.defaultView;
  if (win?.getComputedStyle(el).cursor !== 'pointer') return false;
  const parent = el.parentElement ?? (el.parentNode instanceof win.ShadowRoot ? el.parentNode.host : null);
  return parent === null || win.getComputedStyle(parent).cursor !== 'pointer';
}

/** How far to look for operable content inside an element before treating it as a container. */
const LOOK_INSIDE = 200;

/**
 * Whether an element holds other things to operate, so its content is shown under it, or stands alone
 * (one line, like a button; icons and text inside are its name). Large subtrees count as holding some.
 */
export function holdsControls(el: Element): boolean {
  const inside = Array.from(el.getElementsByTagName('*'));
  if (inside.length > LOOK_INSIDE) return true;
  // Cheapest signal first over all of them: roles, then listener queries, then styles (layout).
  return (
    inside.some((child) => isInteractive(child, roleOf(child))) ||
    inside.some((child) => (child as HTMLElement).onclick != null || pageListensForClicks(child)) ||
    inside.some(pointerStartsHere)
  );
}
