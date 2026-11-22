import type { Action, Locator } from '@eab/core';

import { accessibleName } from './accname.js';
import { snapshotRoleOf } from './clickable.js';
import { readState } from './editing.js';
import { resolveLocator, type FindContext } from './find.js';

/** The CDP binding the engine adds to the agent's world while recording (protocol 1.1). */
export const RECORD_BINDING = '__eabRecord';

/** One user action as the recorder reports it. Password values are never sent (`secret`). */
export interface RecordedAction {
  readonly action: Action;
  readonly url: string;
  readonly secret?: boolean;
}

/** Bounds of what is reported (the engine refuses larger records). */
const MAX_URL = 2_000;
const MAX_VALUE = 8_000;
const MAX_CSS = 500;
const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number', 'password']);
const MAX_TEXT = 80;
/** Roles that do not identify an element (Playwright's `getByRole` cannot find them by name). */
const ROLELESS = new Set(['generic', 'none', 'presentation']);
const MAX_NAME = 200;
/** Ancestors climbed from a click's target to the control the user meant (an icon inside a button). */
const MAX_CLIMB = 5;
/** Keys worth recording on their own; everything printable is part of a `fill`. */
const SPECIAL_KEYS = new Set([
  'Enter',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'Delete',
  'Backspace',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
]);
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/**
 * The most stable locator that finds exactly this element: role + exact name, then the same with
 * `nth`, then exact text, then an id, a test id or a CSS path. Each candidate is checked against the
 * page as the bridge itself would resolve it.
 */
export function locatorFor(el: Element, context: FindContext): Locator {
  const role = snapshotRoleOf(el);
  const name = role === undefined ? '' : accessibleName(el, role).trim();
  // A `generic` element (a div with a click listener) has no role other tools can find it by.
  if (role !== undefined && !ROLELESS.has(role) && name !== '' && name.length <= MAX_NAME) {
    const named: Locator = { role, name, exact: true };
    const matches = resolveLocator(named, context);
    if (matches.length === 1 && matches[0] === el) return named;
    const index = matches.indexOf(el);
    if (index >= 0) return { ...named, nth: index };
  }
  return textLocator(el, context) ?? cssLocator(el, role, context);
}

/** Exact visible text, when it finds exactly this element. */
function textLocator(el: Element, context: FindContext): Locator | undefined {
  const text = el.textContent.replace(/\s+/g, ' ').trim();
  if (text === '' || text.length > MAX_TEXT) return undefined;
  const byText: Locator = { text, exact: true };
  const matches = resolveLocator(byText, context);
  return matches.length === 1 && (matches[0] === el || el.contains(matches[0] ?? null)) ? byText : undefined;
}

/** A CSS path, or for a very deep element its role and position, else the path's end (bounded). */
function cssLocator(el: Element, role: string | undefined, context: FindContext): Locator {
  const css = cssPath(el);
  if (css.length <= MAX_CSS) return { css };
  if (role !== undefined) {
    const index = resolveLocator({ role }, context).indexOf(el);
    if (index >= 0) return { role, nth: index };
  }
  return { css: css.slice(css.length - MAX_CSS).replace(/^[^>]*>\s*/, '') };
}

/** A selector unique in the document: `#id`, a test id, or a `tag:nth-of-type` path from the body. */
export function cssPath(el: Element): string {
  const doc = el.ownerDocument;
  const unique = (selector: string): boolean => {
    try {
      const found = doc.querySelectorAll(selector);
      return found.length === 1 && found[0] === el;
    } catch {
      return false;
    }
  };
  if (el.id !== '' && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
  for (const attribute of ['data-testid', 'data-test', 'data-test-id', 'name']) {
    const value = el.getAttribute(attribute);
    const selector = value === null ? '' : `${el.tagName.toLowerCase()}[${attribute}="${CSS.escape(value)}"]`;
    if (selector !== '' && unique(selector)) return selector;
  }
  const parts: string[] = [];
  for (let current: Element | null = el; current && current !== doc.body; current = current.parentElement) {
    const node: Element = current;
    const tag = node.tagName.toLowerCase();
    const siblings = node.parentElement ? Array.from(node.parentElement.children) : [];
    const same = siblings.filter((sibling) => sibling.tagName === node.tagName);
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
    const selector = `body > ${parts.join(' > ')}`;
    if (unique(selector)) return selector;
  }
  return `body > ${parts.join(' > ')}`;
}

/** The element a trusted event happened on (events the page dispatches itself are not the user's). */
function elementOf(event: Event, trusted: (event: Event) => boolean): Element | undefined {
  const target = event.target as Partial<Element> | null;
  if (!trusted(event) || target?.nodeType !== 1 || typeof target.closest !== 'function') return undefined;
  return target as Element;
}

/** Text-like fields record a `fill` of their final value; checkboxes, radios and selects their state. */
function fieldKind(el: Element): 'text' | 'check' | 'select' | 'file' | undefined {
  if (el.tagName === 'TEXTAREA') return 'text';
  if (el.tagName === 'SELECT') return 'select';
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type.toLowerCase();
    if (type === 'checkbox' || type === 'radio') return 'check';
    if (type === 'file') return 'file';
    return TEXT_TYPES.has(type) ? 'text' : undefined;
  }
  return (el as HTMLElement).isContentEditable ? 'text' : undefined;
}

function valueOf(el: Element): string {
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return (el as HTMLInputElement).value;
  return el.textContent;
}

function isSecret(el: Element): boolean {
  return el.tagName === 'INPUT' && (el as HTMLInputElement).type.toLowerCase() === 'password';
}

/** The element a click meant: the nearest ancestor (or itself) with a role a snapshot shows. */
function clickTarget(start: Element): Element {
  let current: Element | null = start;
  for (let depth = 0; current && depth <= MAX_CLIMB; depth++, current = current.parentElement) {
    const role = snapshotRoleOf(current);
    if (role !== undefined && role !== 'generic' && role !== 'none') return current;
  }
  return start;
}

/** Fields record their value or state on change; a label click is its control's change. */
function changesAField(target: Element, el: Element): boolean {
  const control = target.closest('label')?.control;
  return fieldKind(el) !== undefined || (control != null && fieldKind(control) !== undefined);
}

/** The button, click count and modifiers of a click, where they are not the defaults. */
function clickOptions(event: MouseEvent): Partial<Extract<Action, { type: 'click' }>> {
  const modifiers = [
    event.altKey ? ('Alt' as const) : undefined,
    event.ctrlKey ? ('Control' as const) : undefined,
    event.metaKey ? ('Meta' as const) : undefined,
    event.shiftKey ? ('Shift' as const) : undefined,
  ].filter((modifier) => modifier !== undefined);
  const button = event.button === 1 ? 'middle' : event.button === 2 ? 'right' : undefined;
  return {
    ...(button === undefined ? {} : { button }),
    ...(event.detail === 2 ? { clickCount: 2 } : {}),
    ...(modifiers.length > 0 ? { modifiers } : {}),
  };
}

function chordOf(event: KeyboardEvent): string | undefined {
  if (MODIFIER_KEYS.has(event.key)) return undefined;
  const command = event.ctrlKey || event.metaKey || event.altKey;
  if (!command && !SPECIAL_KEYS.has(event.key)) return undefined;
  const key = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const modifiers = [
    event.ctrlKey ? 'Control' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    event.metaKey ? 'Meta' : '',
  ].filter((modifier) => modifier !== '');
  return [...modifiers, key].join('+');
}

/**
 * Capture the user's clicks, field changes and command keys in this document and report each as an
 * action (`sink` gets JSON). Listens in the capture phase on the window, so the page cannot hide events
 * from it by stopping propagation; never prevents or changes anything. Returns how to stop.
 */
export function startRecording(
  win: Window,
  context: FindContext,
  sink: (payload: string) => void,
  trusted: (event: Event) => boolean = (event) => event.isTrusted,
): () => void {
  const reported = new WeakMap<Element, string>();
  const report = (action: Action, secret = false): void => {
    try {
      const record: RecordedAction = {
        action,
        url: win.document.URL.slice(0, MAX_URL),
        ...(secret ? { secret: true } : {}),
      };
      sink(JSON.stringify(record));
    } catch {
      // Recording never breaks the page.
    }
  };
  /** A field's value, once per distinct value (typing ends in one `fill`). */
  const fill = (el: Element): void => {
    const value = valueOf(el);
    if (reported.get(el) === value) return;
    reported.set(el, value);
    const secret = isSecret(el);
    report(
      { type: 'fill', locator: locatorFor(el, context), value: secret ? '' : value.slice(0, MAX_VALUE) },
      secret,
    );
  };
  /**
   * Where the last press went down, and the locator of what it meant then: a press that opens an overlay
   * (a select's menu) makes the click land on a common ancestor, and may hide the page behind it
   * (`aria-hidden`), where nothing could be found any more.
   */
  let pressed: { readonly at: Element; readonly target: Element; readonly locator: Locator } | undefined;
  const onPointerDown = (event: Event): void => {
    const at = elementOf(event, trusted);
    if (at === undefined) {
      pressed = undefined;
      return;
    }
    try {
      const target = clickTarget(at);
      pressed = { at, target, locator: locatorFor(target, context) };
    } catch {
      pressed = undefined;
    }
  };
  // A press that will not become a click (a drag, a cancelled touch) must not steer a later one.
  const onPressLost = (): void => {
    pressed = undefined;
  };
  const onClick = (event: MouseEvent): void => {
    const landed = elementOf(event, trusted);
    if (landed === undefined) return;
    const press = pressed;
    pressed = undefined;
    const target =
      press !== undefined && landed !== press.at && landed.contains(press.at) ? press.at : landed;
    // A click on the page itself (nothing under the pointer that a user meant) is not an action.
    if (target === win.document.documentElement || target === win.document.body) return;
    const el = clickTarget(target);
    if (changesAField(target, el)) return;
    report({
      type: 'click',
      locator: press?.target === el ? press.locator : locatorFor(el, context),
      ...clickOptions(event),
    });
  };
  const onChange = (event: Event): void => {
    const el = elementOf(event, trusted);
    if (el === undefined) return;
    const kind = fieldKind(el);
    if (kind === 'text') fill(el);
    else if (kind === 'check') {
      const input = el as HTMLInputElement;
      report({
        type: input.checked || input.type === 'radio' ? 'check' : 'uncheck',
        locator: locatorFor(el, context),
      });
    } else if (kind === 'select') {
      const values = [...(readState(el).selected ?? [])];
      report({ type: 'select', locator: locatorFor(el, context), values });
    }
  };
  const onKey = (event: KeyboardEvent): void => {
    if (!trusted(event)) return;
    const key = chordOf(event);
    if (key === undefined) return;
    const focused = win.document.activeElement;
    const inField = focused !== null && focused !== win.document.body && fieldKind(focused) === 'text';
    // The value typed so far comes first: Enter usually submits it.
    if (inField) fill(focused);
    const onElement = focused !== null && focused !== win.document.body;
    report({ type: 'press', key, ...(onElement ? { locator: locatorFor(focused, context) } : {}) });
  };
  const onFocusOut = (event: FocusEvent): void => {
    const el = elementOf(event, trusted);
    if (
      (el as HTMLElement | undefined)?.isContentEditable === true &&
      el !== undefined &&
      fieldKind(el) === 'text'
    ) {
      fill(el);
    }
  };
  const options = { capture: true, passive: true } as const;
  win.addEventListener('pointerdown', onPointerDown, options);
  win.addEventListener('pointercancel', onPressLost, options);
  win.addEventListener('dragstart', onPressLost, options);
  win.addEventListener('click', onClick, options);
  win.addEventListener('auxclick', onClick, options);
  win.addEventListener('change', onChange, options);
  win.addEventListener('keydown', onKey, options);
  win.addEventListener('focusout', onFocusOut, options);
  return () => {
    win.removeEventListener('pointerdown', onPointerDown, options);
    win.removeEventListener('pointercancel', onPressLost, options);
    win.removeEventListener('dragstart', onPressLost, options);
    win.removeEventListener('click', onClick, options);
    win.removeEventListener('auxclick', onClick, options);
    win.removeEventListener('change', onChange, options);
    win.removeEventListener('keydown', onKey, options);
    win.removeEventListener('focusout', onFocusOut, options);
  };
}
