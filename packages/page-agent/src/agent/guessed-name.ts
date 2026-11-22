import { MAX_NAME, accessibleName, nameAsIfShown } from './accname.js';
import { clip } from './dom.js';

/** The name a snapshot line shows: the accessible name, or a guess when the page gives none. */
export interface ShownName {
  readonly text: string;
  /** Not the accessible name: inferred from the column, a tooltip or the icon (shown as such). */
  readonly guessed: boolean;
}

/** Roles a user operates: worth a guessed name when the page gives them none. */
const OPERABLE = new Set([
  'button',
  'link',
  'clickable',
  'menuitem',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton',
  'slider',
]);

/**
 * The name to show for an element. Unnamed controls are common in real apps (icon buttons, grid
 * inputs), and a line like `button ""` leaves an agent guessing from position; so for those the name
 * is inferred from what a sighted user goes by — the column header above a grid input, a tooltip, the
 * icon — and marked as a guess.
 */
export function shownName(el: Element, role: string, asIfShown = false): ShownName {
  const text = asIfShown ? nameAsIfShown(el, role) : accessibleName(el, role);
  if (text !== '' || !OPERABLE.has(role)) return { text, guessed: false };
  const guess = columnHeader(el) || hintOf(el);
  return guess === '' ? { text, guessed: false } : { text: clip(guess, MAX_NAME), guessed: true };
}

const CELL = 'td, th, [role="cell"], [role="gridcell"]';
const TABLE = 'table, [role="table"], [role="grid"], [role="treegrid"]';
const ROW = 'tr, [role="row"]';
const HEADER_CELL = 'th, [role="columnheader"]';

/** Text entry: a row holding it is data; headers hold at most sort buttons and toggles. */
const CONTROL =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, [role="textbox"], [contenteditable="true"]';

/**
 * The header text of the column a control sits in (first line: sub-headers and toggles follow). The
 * header row is the one with header cells, else (tables built from plain cells) the first row
 * without text entry.
 */
function columnHeader(el: Element): string {
  const cell = el.closest(CELL);
  const row = cell?.closest(ROW);
  const table = row?.closest(TABLE);
  if (!cell || !row || !table) return '';
  const rows = Array.from(table.querySelectorAll(ROW)).filter(
    (candidate) => candidate !== row && candidate.closest(TABLE) === table,
  );
  const header =
    rows.find((candidate) => cellsOf(candidate).some((c) => c.matches(HEADER_CELL))) ??
    rows.find((candidate) => cellsOf(candidate).length > 0 && candidate.querySelector(CONTROL) === null);
  if (!header || header.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING) return '';
  const column = columnOf(row, cell);
  let start = 0;
  for (const headerCell of cellsOf(header)) {
    const span = spanOf(headerCell);
    if (column >= start && column < start + span) return firstLine(headerCell);
    start += span;
  }
  return '';
}

function cellsOf(row: Element): Element[] {
  return Array.from(row.children).filter((child) => child.matches(CELL));
}

function spanOf(cell: Element): number {
  return Math.max(1, (cell as HTMLTableCellElement).colSpan || 1);
}

function columnOf(row: Element, cell: Element): number {
  let column = 0;
  for (const candidate of cellsOf(row)) {
    if (candidate === cell) return column;
    column += spanOf(candidate);
  }
  return column;
}

/** The first text of a header cell, outside its controls (sort buttons, tax toggles). */
function firstLine(el: Element): string {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').trim();
    if (text !== '' && node.parentElement?.closest(HEADER_CONTROL) == null) return text;
  }
  return '';
}

const HEADER_CONTROL =
  'select, button, input, textarea, [role="button"], [role="combobox"], [role="listbox"]';

/** Tooltip attributes of the common tooltip libraries. */
const TOOLTIP_ATTRIBUTES = [
  'data-tooltip',
  'data-tip',
  'data-title',
  'data-original-title',
  'data-bs-original-title',
  'data-tooltip-content',
  'mattooltip',
];

/** Icon-library class names: Tabler, Lucide, Font Awesome, Bootstrap, Material Design, Remix, Feather. */
const ICON_CLASS =
  /^(?:tabler-icon-|lucide-|fa-|bi-|mdi-|ri-|feather-|icon-)([a-z][\w-]*?)(?:-(?:line|fill|outline|filled))?$/;
const NOT_ICON_NAMES = new Set([
  'solid',
  'regular',
  'light',
  'brands',
  'fw',
  'lg',
  'xs',
  'sm',
  'spin',
  'icon',
]);
/** CSS-module class names keep their author's name before a generated suffix: `addRow___x9y8z`. */
const MODULE_CLASS = /^([a-zA-Z][a-zA-Z0-9]*?)_{2,3}[\w-]{4,}$/;
/** Generated ids that say nothing (`radix-5`, `:r3:`, `mui-12`). */
const GENERATED_ID = /\d|^(radix|mui|react|headlessui)/i;
const FILLER_WORDS = new Set([
  'button',
  'btn',
  'icon',
  'svg',
  'wrapper',
  'container',
  'root',
  'trigger',
  'with',
  'without',
  'text',
]);

/** A hint from the element and its content: tooltip, SVG title, icon class, test id, id, module class. */
function hintOf(el: Element): string {
  const scope = [el, ...Array.from(el.getElementsByTagName('*')).slice(0, 20)];
  for (const node of scope) {
    for (const attribute of TOOLTIP_ATTRIBUTES) {
      const tooltip = node.getAttribute(attribute)?.trim();
      // Some libraries point at their tooltip element (`#help`) instead of holding its text.
      if (tooltip && !/^[#.]/.test(tooltip)) return tooltip;
    }
  }
  const title = el.querySelector('svg > title')?.textContent.trim();
  if (title) return title;
  for (const finder of [iconName, testIdName, idName, moduleClassName]) {
    for (const node of scope) {
      const found = finder(node);
      if (found !== '') return found;
    }
  }
  return '';
}

function iconName(node: Element): string {
  for (const name of classesOf(node)) {
    const icon = ICON_CLASS.exec(name)?.[1];
    if (icon !== undefined && !NOT_ICON_NAMES.has(icon)) return words(icon);
  }
  return '';
}

function testIdName(node: Element): string {
  const id = node.getAttribute('data-testid') ?? node.getAttribute('data-test-id');
  return id ? words(id) : '';
}

function idName(node: Element): string {
  return node.id !== '' && !GENERATED_ID.test(node.id) ? words(node.id) : '';
}

function moduleClassName(node: Element): string {
  for (const name of classesOf(node)) {
    const author = MODULE_CLASS.exec(name)?.[1];
    if (author !== undefined) return words(author);
  }
  return '';
}

function classesOf(node: Element): string[] {
  const value = node.getAttribute('class');
  return value ? value.split(/\s+/) : [];
}

/** `DeleteOutlinedIcon` → "delete outlined"; `add-more_button` → "add more". */
function words(identifier: string): string {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word !== '' && !FILLER_WORDS.has(word))
    .join(' ');
}
