/**
 * DOM → accessibility-style semantics: roles, visibility, states and values. A practical subset of
 * HTML-AAM / ARIA, enough for agents to recognise and target controls. Pure functions of the DOM.
 */

/** Elements that never render content. */
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'META', 'LINK', 'TITLE']);

const INPUT_ROLES: Readonly<Record<string, string>> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  file: 'button',
  search: 'searchbox',
  color: 'button',
};

const TAG_ROLES: Readonly<Record<string, string>> = {
  BUTTON: 'button',
  TEXTAREA: 'textbox',
  NAV: 'navigation',
  MAIN: 'main',
  HEADER: 'banner',
  FOOTER: 'contentinfo',
  ASIDE: 'complementary',
  DIALOG: 'dialog',
  UL: 'list',
  OL: 'list',
  MENU: 'list',
  LI: 'listitem',
  TABLE: 'table',
  TR: 'row',
  TD: 'cell',
  TH: 'columnheader',
  FIELDSET: 'group',
  OPTION: 'option',
  PROGRESS: 'progressbar',
  METER: 'meter',
  FORM: 'form',
  ARTICLE: 'article',
  DETAILS: 'group',
  SUMMARY: 'button',
  IFRAME: 'iframe',
  HR: 'separator',
};

/** Roles whose accessible name comes from their content. */
export const NAME_FROM_CONTENT = new Set([
  'button',
  'link',
  'heading',
  'option',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'cell',
  'columnheader',
  'rowheader',
  'treeitem',
  'tooltip',
  'switch',
  'checkbox',
  'radio',
  // Role-less elements shown as `clickable` (see clickable.ts).
  'clickable',
]);

/** Roles whose subtree is summarised by their own line (nothing useful underneath). */
export const LEAF_ROLES = new Set([
  'button',
  'link',
  'heading',
  'option',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'cell',
  'columnheader',
  'rowheader',
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'img',
  'progressbar',
  'meter',
  'separator',
]);

/** Roles a user can operate. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'spinbutton',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'treeitem',
]);

/** Roles that only exist to be ignored. */
const PRESENTATIONAL = new Set(['presentation', 'none', 'generic']);

/** The element's role, or `undefined` when it is a plain container whose children are hoisted. */
export function roleOf(el: Element): string | undefined {
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0]?.toLowerCase();
  if (explicit) return PRESENTATIONAL.has(explicit) ? undefined : explicit;
  const implicit = implicitRole(el);
  if (implicit) return implicit;
  const editable = el.getAttribute('contenteditable');
  return editable !== null && editable !== 'false' ? 'textbox' : undefined;
}

function implicitRole(el: Element): string | undefined {
  const tag = el.tagName;
  if (tag === 'A' || tag === 'AREA') return el.hasAttribute('href') ? 'link' : undefined;
  if (/^H[1-6]$/.test(tag)) return 'heading';
  if (tag === 'IMG') return el.getAttribute('alt') === '' ? undefined : 'img';
  if (tag === 'SELECT') return selectRole(el as HTMLSelectElement);
  if (tag === 'INPUT') return inputRole(el as HTMLInputElement);
  if (tag === 'SECTION')
    return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : undefined;
  return TAG_ROLES[tag];
}

function selectRole(select: HTMLSelectElement): string {
  return select.multiple || Number(select.getAttribute('size')) > 1 ? 'listbox' : 'combobox';
}

function inputRole(input: HTMLInputElement): string | undefined {
  const type = (input.getAttribute('type') ?? 'text').toLowerCase();
  if (type === 'hidden') return undefined;
  if (input.hasAttribute('list') && ['text', 'search', 'email', 'tel', 'url'].includes(type))
    return 'combobox';
  return INPUT_ROLES[type] ?? 'textbox';
}

/**
 * How an element takes part in the accessibility tree:
 * - `hidden`: it and its whole subtree are absent (non-rendering tags, `hidden`, `aria-hidden`,
 *   `display: none` here or above);
 * - `self`: the element itself is invisible (`visibility: hidden | collapse`) but descendants can
 *   override visibility and still show;
 * - `visible`.
 * `display: contents` boxes report "not rendered" to `checkVisibility()`, yet render their children.
 * A fixed box entirely outside the viewport (an off-canvas drawer) is `hidden`: no scrolling shows it.
 */
export function visibilityOf(el: Element): 'visible' | 'self' | 'hidden' {
  if (SKIP.has(el.tagName) || el.getAttribute('aria-hidden') === 'true') return 'hidden';
  const html = el as HTMLElement;
  if (html.hidden && el.tagName !== 'DETAILS') return 'hidden';
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return 'visible';
  if (!rendersBox(html, style) || (style.position === 'fixed' && fixedOffScreen(html))) return 'hidden';
  return style.visibility === 'hidden' || style.visibility === 'collapse' ? 'self' : 'visible';
}

function rendersBox(el: HTMLElement, style: CSSStyleDeclaration): boolean {
  if (style.display === 'contents') return true;
  return typeof el.checkVisibility === 'function' ? el.checkVisibility() : style.display !== 'none';
}

/**
 * Whether a fixed box (a drawer slid away) and everything in it lies entirely outside the viewport.
 * Boxes without size (layout-less hosts, test DOMs) are never judged off screen, nor boxes with more
 * content than is worth measuring.
 */
function fixedOffScreen(el: HTMLElement): boolean {
  const win = el.ownerDocument.defaultView;
  const box = el.getBoundingClientRect();
  if (!win || box.width === 0 || box.height === 0 || !offScreen(box, win)) return false;
  const inside = el.getElementsByTagName('*');
  if (inside.length > MEASURE_INSIDE) return false;
  // Content can overflow the box any way, or be placed on its own (fixed itself).
  for (const child of inside) if (!offScreen(child.getBoundingClientRect(), win)) return false;
  return true;
}

const MEASURE_INSIDE = 2000;

/** Whether a box lies outside the viewport (empty boxes count as outside: they show nothing). */
function offScreen(box: DOMRect, win: Window): boolean {
  if (box.width === 0 && box.height === 0) return true;
  return box.right <= 0 || box.bottom <= 0 || box.left >= win.innerWidth || box.top >= win.innerHeight;
}

/** Whether the element itself is not perceivable (see {@link visibilityOf}). */
export function isHidden(el: Element): boolean {
  return visibilityOf(el) !== 'visible';
}

/** Elements whose state can change without any DOM mutation (typing, checking, selecting). */
export function isLive(el: Element, role: string | undefined): boolean {
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return role === 'textbox' || role === 'combobox';
}

/** Whether a user can operate the element. */
export function isInteractive(el: Element, role: string | undefined): boolean {
  if (role !== undefined && INTERACTIVE_ROLES.has(role)) return true;
  const tabindex = el.getAttribute('tabindex');
  return tabindex !== null && tabindex !== '-1';
}

/** `disabled`, `checked`, `expanded=…`, `level=…` and friends, in a fixed order. */
export function statesOf(el: Element, role: string | undefined): string[] {
  const level = headingLevel(el, role);
  const candidates = [
    flag(el, 'disabled', 'aria-disabled') ? 'disabled' : undefined,
    checkedState(el, role),
    flag(el, 'selected', 'aria-selected') ? 'selected' : undefined,
    pressedState(el),
    expandedState(el),
    flag(el, 'required', 'aria-required') ? 'required' : undefined,
    flag(el, 'readOnly', 'aria-readonly') ? 'readonly' : undefined,
    level === undefined ? undefined : `level=${level}`,
    ariaFlag(el, 'aria-current') ? 'current' : undefined,
    el.tagName === 'DIALOG' && flag(el, 'open') ? 'open' : undefined,
  ];
  return candidates.filter((state): state is string => state !== undefined);
}

/**
 * A boolean DOM property (`disabled`, `checked`…) or its ARIA twin. Read untyped: the property only
 * exists on some elements, whatever the static types say.
 */
function flag(el: Element, property: string, aria?: string): boolean {
  if ((el as unknown as Record<string, unknown>)[property] === true) return true;
  return aria !== undefined && el.getAttribute(aria) === 'true';
}

function ariaFlag(el: Element, attribute: string): boolean {
  const value = el.getAttribute(attribute);
  return value !== null && value !== '' && value !== 'false';
}

function pressedState(el: Element): string | undefined {
  const pressed = el.getAttribute('aria-pressed');
  return pressed === 'true' ? 'pressed' : pressed === 'mixed' ? 'pressed=mixed' : undefined;
}

function expandedState(el: Element): string | undefined {
  const aria = el.getAttribute('aria-expanded');
  const expanded = aria ?? (el.tagName === 'DETAILS' ? String(flag(el, 'open')) : null);
  return expanded === 'true' || expanded === 'false' ? `expanded=${expanded}` : undefined;
}

function checkedState(el: Element, role: string | undefined): string | undefined {
  const input = el as HTMLInputElement;
  if (el.tagName === 'INPUT' && (input.type === 'checkbox' || input.type === 'radio')) {
    if (input.indeterminate) return 'checked=mixed';
    return input.checked ? 'checked' : undefined;
  }
  if (role !== 'checkbox' && role !== 'radio' && role !== 'switch' && role !== 'menuitemcheckbox')
    return undefined;
  const aria = el.getAttribute('aria-checked');
  return aria === 'true' ? 'checked' : aria === 'mixed' ? 'checked=mixed' : undefined;
}

function headingLevel(el: Element, role: string | undefined): number | undefined {
  if (role !== 'heading') return undefined;
  const aria = Number(el.getAttribute('aria-level'));
  if (Number.isInteger(aria) && aria > 0) return aria;
  const match = /^H([1-6])$/.exec(el.tagName);
  return match ? Number(match[1]) : 2;
}

/** Text fields an ARIA 1.1 combobox may wrap. */
const TEXT_FIELD =
  'input, textarea, [role="textbox"], [role="searchbox"], [contenteditable=""], [contenteditable="true"]';

/** Roles whose value a snapshot shows. */
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox', 'slider']);

/** Current value of a value-bearing control; passwords are never revealed. */
export function valueOf(
  el: Element,
  role: string | undefined,
): { value: string } | { redacted: true } | undefined {
  if (el.tagName === 'SELECT') {
    const select = el as HTMLSelectElement;
    if (select.multiple) return undefined;
    const option = select.selectedOptions[0];
    return option ? { value: option.textContent.trim() } : undefined;
  }
  if (role === undefined || !VALUE_ROLES.has(role)) return undefined;
  const input = el as HTMLInputElement;
  // An ARIA 1.1 combobox wraps its own text field, which shows the value; its text is labels and choices.
  if (role === 'combobox' && !('value' in input) && el.querySelector(TEXT_FIELD) !== null) return undefined;
  // A <button> has a `value` too (a form field's, usually empty): a button combobox shows its choice as text.
  const value =
    'value' in input && typeof input.value === 'string' && el.tagName !== 'BUTTON'
      ? input.value
      : el.textContent.replace(/\s+/g, ' ').trim();
  if (value === '') return undefined;
  return input.type === 'password' ? { redacted: true } : { value };
}
