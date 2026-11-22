import type { Locator, WaitCondition } from '@eab/core';

import { accessibleName } from './accname.js';
import { isDisabled } from './actionability.js';
import { resolveInDom, type FindContext } from './find.js';
import { clip } from './dom.js';
import type { RefTable } from './refs.js';
import { isHidden, roleOf } from './semantics.js';

/** What the page shows in live regions and dialogs right now (for "what did this action cause"). */
export interface LiveState {
  /** Live-region text by ref (status, alert, log, aria-live, output). */
  readonly regions: Readonly<Record<string, string>>;
  /** Visible dialogs as `role "name"`. */
  readonly dialogs: readonly string[];
}

const LIVE = '[role=status],[role=alert],[role=log],[aria-live]:not([aria-live=off]),output';
const DIALOGS = '[role=dialog],[role=alertdialog],dialog[open]';

export function liveState(doc: Document, refs: RefTable): LiveState {
  const regions: Record<string, string> = {};
  for (const el of Array.from(doc.querySelectorAll(LIVE))) {
    if (isHidden(el)) continue;
    const text = clip(el.textContent, 200);
    if (text !== '') regions[`e${refs.refOf(el)}`] = text;
  }
  const dialogs = Array.from(doc.querySelectorAll(DIALOGS))
    .filter((el) => !isHidden(el))
    .map((el) => {
      const role = roleOf(el) ?? 'dialog';
      return `${role} ${JSON.stringify(accessibleName(el, role))}`;
    });
  return { regions, dialogs };
}

/**
 * Resolves once the DOM has been quiet for `idleMs` (no mutations), or after `capMs` at the latest.
 * Returns the time waited. Lets the page react to an action before its effects are reported.
 */
export function quiet(win: Window, idleMs: number, capMs: number): Promise<number> {
  const started = win.performance.now();
  let last = started;
  const observer = new MutationObserver(() => {
    last = win.performance.now();
  });
  observer.observe(win.document, { subtree: true, childList: true, attributes: true, characterData: true });
  return new Promise((resolve) => {
    const tick = (): void => {
      const now = win.performance.now();
      if (now - last >= idleMs || now - started >= capMs) {
        observer.disconnect();
        resolve(Math.round(now - started));
        return;
      }
      win.setTimeout(tick, Math.min(idleMs, 25));
    };
    win.setTimeout(tick, Math.min(idleMs, 25));
  });
}

/** Fields whose suggestions (autocomplete, comboboxes) appear only after a debounce. */
const SUGGESTING = '[role="combobox"], [aria-autocomplete], [aria-haspopup="listbox"], input[list]';

/** Whether the focused element (through open shadow roots) is a field that shows suggestions. */
export function showsSuggestions(doc: Document): boolean {
  let focused = doc.activeElement;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  return focused != null && focused !== doc.body && focused.closest(SUGGESTING) !== null;
}

/** Whether a wait condition holds now, with what was observed (for reasoned timeouts). */
export interface ConditionCheck {
  readonly met: boolean;
  readonly observed: string;
}

export function checkCondition(condition: WaitCondition, doc: Document, find: FindContext): ConditionCheck {
  switch (condition.kind) {
    case 'element':
      return elementState(condition.locator, condition.state ?? 'visible', find);
    case 'text': {
      const where = textShown(doc, condition.text);
      const wanted = condition.present ?? true;
      return {
        met: (where !== undefined) === wanted,
        observed: where === undefined ? 'the text is not shown' : `the text is shown${where}`,
      };
    }
    case 'url':
      return { met: doc.URL.includes(condition.contains), observed: `url is ${doc.URL}` };
    case 'ipc':
    case 'networkIdle':
    case 'state':
      return { met: false, observed: `${condition.kind} is checked outside the page` };
  }
}

/**
 * Where `text` shows: rendered text, else a visible element's name or value as snapshots show it. A
 * `title` counts only for an element without text of its own: otherwise it is a tooltip, not shown.
 */
function textShown(doc: Document, text: string): string | undefined {
  if (doc.body.innerText.includes(text)) return '';
  for (const el of doc.body.querySelectorAll(NAMED)) {
    if (!isHidden(el) && namesOf(el).some((name) => name.includes(text))) return ' as a name or value';
  }
  return undefined;
}

const NAMED = '[aria-label], [title], [alt], [placeholder], input, textarea, select';

function namesOf(el: Element): string[] {
  const shown = ['aria-label', 'alt', 'placeholder'];
  if (el.textContent.trim() === '') shown.push('title');
  const names = shown.map((name) => el.getAttribute(name) ?? '');
  if ('value' in el && typeof el.value === 'string') names.push(el.value);
  return names;
}

function elementState(
  locator: Locator,
  state: 'attached' | 'detached' | 'visible' | 'hidden' | 'enabled',
  find: FindContext,
): ConditionCheck {
  // The whole DOM, hidden elements included: 'attached' and 'detached' are about presence, not visibility.
  const matches = resolveInDom(locator, find);
  if (state === 'detached')
    return { met: matches.length === 0, observed: `${matches.length} matching element(s)` };
  if (matches.length === 0) return { met: state === 'hidden', observed: 'no matching element' };
  const visible = matches.filter((el) => !isHidden(el));
  const enabled = visible.filter((el) => !isDisabled(el));
  const observed = `${matches.length} match(es), ${visible.length} visible, ${enabled.length} enabled`;
  switch (state) {
    case 'attached':
      return { met: true, observed };
    case 'visible':
      return { met: visible.length > 0, observed };
    case 'hidden':
      return { met: visible.length === 0, observed };
    case 'enabled':
      return { met: enabled.length > 0, observed };
  }
}
