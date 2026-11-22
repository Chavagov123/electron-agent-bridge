/**
 * The event the isolated-world agent dispatches at an element to ask the main-world hook whether the
 * page listens for clicks on it (see `state/clicks.ts`): cancelled means yes.
 */
export const CLICKABLE_QUERY = 'electron-agent-bridge.v1.clickable';

/**
 * Whether each document has the main-world hook. It is installed at document start, before anything
 * asks, so the answer holds for the document's life (iframes and non-app pages never have it).
 */
const hooked = new WeakMap<Document, boolean>();

/** Composed, so a query at an element in an (open) shadow root reaches the hook's listener on window. */
const QUERY = { cancelable: true, composed: true };

/** Whether the page's own code listens for clicks on `el` (false when the hook is not in this page). */
export function pageListensForClicks(el: Element): boolean {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  if (!win) return false;
  let present = hooked.get(doc);
  if (present === undefined) {
    present = !doc.dispatchEvent(new win.CustomEvent(CLICKABLE_QUERY, QUERY));
    hooked.set(doc, present);
  }
  return present && !el.dispatchEvent(new win.CustomEvent(CLICKABLE_QUERY, QUERY));
}
