import type { Locator } from '@electron-agent-bridge/core';

import { MAX_NAME } from './accname.js';
import { clip } from './dom.js';
import { parseRef, type RefTable } from './refs.js';
import { CLICKABLE, clickableOf, snapshotRoleOf } from './clickable.js';
import { shownName } from './guessed-name.js';
import { isHidden, roleOf } from './semantics.js';
import { headOf, type TreeNode } from './tree.js';

/** One element matched by a locator. */
export interface Match {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly line: string;
}

export interface FindContext {
  readonly doc: Document;
  readonly refs: RefTable;
  /** The current tree of the whole page (cached build). */
  readonly nodes: () => readonly TreeNode[];
  /** A node's current line: live nodes recomputed, `undefined` when it is hidden now. */
  readonly head: (node: TreeNode) => string | undefined;
  /** The DOM's generation (changes with every mutation): lets lookups be reused within one. */
  readonly generation?: () => number;
}

/** Thrown for locators that cannot be evaluated (e.g. invalid CSS). */
export class LocatorError extends Error {
  override readonly name = 'LocatorError';
}

/**
 * Elements matching a locator, in document order. `ref` and `css` address elements directly;
 * `role`/`name`/`text` match against the accessibility-style tree (what an agent sees).
 * `nth` picks one of several matches.
 */
export function resolveLocator(locator: Locator, context: FindContext): Element[] {
  return pick(candidates(locator, context), locator.nth);
}

/**
 * Like {@link resolveLocator}, but over the whole document, hidden elements included: for waits on an
 * element being attached or detached, and for targets that are usually hidden (file inputs). Role and
 * name are computed per element; shadow roots are not entered.
 */
export function resolveInDom(locator: Locator, context: FindContext): Element[] {
  const direct = locator.ref !== undefined || locator.css !== undefined;
  return pick(direct ? candidates(locator, context) : domCandidates(locator, context.doc), locator.nth);
}

function pick(all: Element[], nth: number | undefined): Element[] {
  if (nth === undefined) return all;
  const picked = all[nth];
  return picked ? [picked] : [];
}

function domCandidates(locator: Locator, doc: Document): Element[] {
  if (locator.role === undefined && locator.name === undefined) {
    // Text only: the elements holding matching text, as text lines in a snapshot would.
    const found = new Set<Element>();
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
      if (text !== '' && node.parentElement && same(text, locator.text ?? '', locator.exact)) {
        found.add(node.parentElement);
      }
    }
    return found.size > 0 ? Array.from(found) : spanningText(doc, locator.text ?? '', locator.exact);
  }
  const wanted = locator.role?.toLowerCase();
  return Array.from(doc.body.querySelectorAll('*')).filter((el) => {
    const role = roleOf(el) ?? clickableRole(el, wanted);
    if (role === undefined) return false;
    if (locator.role !== undefined && role.toLowerCase() !== locator.role.toLowerCase()) return false;
    const name = shownName(el, role, true).text;
    if (locator.name !== undefined && !same(name, locator.name, locator.exact)) return false;
    return locator.text === undefined || same(name, locator.text, locator.exact);
  });
}

/**
 * Text split across elements or lines (`Download<br>PDF`): the innermost elements whose rendered text,
 * with line breaks as spaces, matches.
 */
function spanningText(doc: Document, text: string, exact: boolean | undefined): Element[] {
  // Text nodes joined with spaces (line breaks and blocks separate words); no layout needed.
  const shown = (el: Element): string => {
    const parts: string[] = [];
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) parts.push(node.nodeValue ?? '');
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };
  const holds = (el: Element): boolean => same(shown(el), text, false);
  // A parent's text holds its children's, so descend only into children holding the text.
  const innermost = (el: Element): Element[] => {
    const inner = Array.from(el.children).filter(holds);
    return inner.length === 0 ? [el] : inner.flatMap(innermost);
  };
  if (text === '' || !holds(doc.body)) return [];
  return innermost(doc.body).filter((el) => el !== doc.body && same(shown(el), text, exact));
}

/**
 * `clickable` for a role-less element a locator may mean: only when it asks for no role (then only
 * one-line clickables, which have no controls inside to match instead) or for `clickable`.
 */
function clickableRole(el: Element, wanted: string | undefined): string | undefined {
  if (wanted !== undefined && wanted !== CLICKABLE) return undefined;
  const clickable = clickableOf(el);
  return clickable !== undefined && (clickable.leaf || wanted === CLICKABLE) ? CLICKABLE : undefined;
}

function candidates(locator: Locator, context: FindContext): Element[] {
  if (locator.ref !== undefined) {
    const id = parseRef(locator.ref);
    const el = id === undefined ? undefined : context.refs.element(id);
    return el ? [el] : [];
  }
  if (locator.css !== undefined) {
    try {
      return Array.from(context.doc.querySelectorAll(locator.css));
    } catch (error) {
      throw new LocatorError(`invalid CSS selector ${JSON.stringify(locator.css)}: ${String(error)}`);
    }
  }
  const found: Element[] = [];
  const seen = new Set<Element>();
  const visit = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      if (!seen.has(node.el) && matches(node, locator, context.head(node))) {
        seen.add(node.el);
        found.push(node.el);
      }
      visit(node.children);
    }
  };
  visit(context.nodes());
  if (found.length > 0 || !textOnly(locator)) return found;
  return spanningText(context.doc, locator.text ?? '', locator.exact).filter((el) => !isHidden(el));
}

function textOnly(locator: Locator): boolean {
  return locator.text !== undefined && locator.role === undefined && locator.name === undefined;
}

function matches(node: TreeNode, locator: Locator, head: string | undefined): boolean {
  // `undefined`: a live control that is hidden now.
  if (head === undefined) return false;
  if (locator.role !== undefined && node.role?.toLowerCase() !== locator.role.toLowerCase()) return false;
  // A clickable holding controls (a card) is named by all of them: only asked for by its role or ref.
  if (node.role === CLICKABLE && node.children.length > 0 && locator.role === undefined) return false;
  // Text nodes carry no role and only answer text queries.
  if (node.role === undefined && locator.text === undefined) return false;
  const label = node.role === undefined ? textOf(head) : nameOf(head);
  if (locator.name !== undefined && !same(label, locator.name, locator.exact)) return false;
  if (locator.text !== undefined && !same(label, locator.text, locator.exact)) return false;
  return true;
}

/** Describe matched elements for the agent (refs are assigned on demand). */
export function describeMatches(elements: readonly Element[], refs: RefTable, limit: number): Match[] {
  return elements.slice(0, limit).map((el) => {
    const ref = refs.refOf(el);
    const semantic = snapshotRoleOf(el);
    // A plain element (matched by text or CSS) is described by its rendered text.
    const name = semantic === undefined ? clip(el.textContent, MAX_NAME) : shownName(el, semantic);
    const role = semantic ?? 'generic';
    const text = typeof name === 'string' ? name : name.text;
    return { ref: `e${ref}`, role, name: text, line: headOf(el, role, ref, name) };
  });
}

function nameOf(head: string): string {
  const match = /^[^ ]+ ("(?:[^"\\]|\\.)*")/.exec(head);
  return match?.[1] ? (JSON.parse(match[1]) as string) : '';
}

function textOf(head: string): string {
  return head.startsWith('text ') ? (JSON.parse(head.slice(5)) as string) : '';
}

function same(actual: string, wanted: string, exact: boolean | undefined): boolean {
  return exact === true ? actual === wanted : actual.toLowerCase().includes(wanted.toLowerCase());
}
