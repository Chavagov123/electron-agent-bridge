import { nameDependsOnOthers } from './accname.js';
import { clip, renderedChildNodes, textOwner } from './dom.js';
import { clickableOf, holdsControls } from './clickable.js';
import { shownName, type ShownName } from './guessed-name.js';
import type { RefTable } from './refs.js';
import { LEAF_ROLES, isHidden, roleOf, isLive, statesOf, valueOf, visibilityOf } from './semantics.js';

/** One line-producing node of the accessibility-style tree. */
export interface TreeNode {
  /** Stable key for deltas: `e<ref>` for elements, `t<id>` for text. */
  readonly key: string;
  /** The element (for text: the element it renders in). */
  readonly el: Element;
  readonly role: string | undefined;
  readonly ref: number | undefined;
  /** Own line without indentation. Recomputed at render time when `live`. */
  readonly head: string;
  /** State can change without a DOM mutation (form controls) or depends on other elements (labels). */
  readonly live: boolean;
  /** A cross-origin iframe the agent cannot look into. */
  readonly crossOrigin: boolean;
  readonly children: readonly TreeNode[];
}

/**
 * Attributes whose change only affects the element's own line. Any other attribute may be used by CSS
 * selectors to show or hide descendants (`[data-state=open] .panel`), so it forces a subtree rebuild.
 */
const LOCAL_ATTRIBUTES = new Set([
  'value',
  'checked',
  'selected',
  'title',
  'placeholder',
  'alt',
  'href',
  'src',
  'tabindex',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-valuenow',
  'aria-valuetext',
  'aria-checked',
  'aria-pressed',
  'aria-selected',
  'aria-current',
]);
const MAX_TEXT = 80;
const CROSS_ORIGIN = ' cross-origin';
/** An Electron `<webview>` is a page of its own: snapshot it as its own target, not through this one. */
const WEBVIEW = ' separate target (see targets)';

/**
 * Builds the tree incrementally. Every element's contribution (its node, or its children hoisted when
 * it has no role) is cached; a MutationObserver marks the changed node and its ancestors dirty, so a
 * rebuild touches only dirty paths and reuses clean subtrees by reference (ADR-0007).
 */
export class TreeBuilder {
  readonly #refs: RefTable;
  readonly #observer: MutationObserver;
  readonly #observed = new WeakSet<Node>();
  readonly #textIds = new WeakMap<Node, number>();
  #nextText = 1;
  #cache = new WeakMap<Node, readonly TreeNode[]>();
  /**
   * Nodes whose contribution must be recomputed. Marks below a leaf (e.g. inside a button) are never
   * visited and so never cleared; weak sets keep them from holding detached nodes alive.
   */
  #dirty = new WeakSet<Node>();
  /** Nodes whose entire subtree must be recomputed (visibility may have changed below them). */
  #subtree = new WeakSet<Node>();
  /** Custom elements without a shadow root yet; dropped once upgraded or disconnected. */
  readonly #pendingHosts = new Set<Element>();
  /** Bumped by every DOM change seen (and every invalidation): cached lookups are valid within one. */
  #generation = 0;

  constructor(refs: RefTable, doc: Document) {
    this.#refs = refs;
    const MutationObserverCtor = doc.defaultView?.MutationObserver ?? MutationObserver;
    this.#observer = new MutationObserverCtor((records) => {
      this.#apply(records);
    });
    this.#watch(doc);
  }

  /** Contribution of `root` (fresh: ignore every cache, for verification). */
  build(root: Element, fresh = false): readonly TreeNode[] {
    this.#apply(this.#observer.takeRecords());
    this.#checkPendingHosts();
    return this.#contribution(root, fresh);
  }

  /** Recompute a node's head (live state, or a name override from the accessibility tree). */
  head(node: TreeNode, nameOverride?: string): string | undefined {
    if (!node.role || node.ref === undefined) return node.head;
    if (isHidden(node.el)) return undefined;
    const name = nameOverride ?? shownName(node.el, node.role);
    return headOf(node.el, node.role, node.ref, name) + (node.crossOrigin ? CROSS_ORIGIN : '');
  }

  /** The DOM's current generation: unchanged means no mutation since the last read. */
  generation(): number {
    this.#apply(this.#observer.takeRecords());
    return this.#generation;
  }

  /** Forget everything (stylesheets changed, viewport resized: any element may look different). */
  invalidateAll(): void {
    this.#generation++;
    this.#cache = new WeakMap();
    this.#dirty = new WeakSet();
    this.#subtree = new WeakSet();
  }

  #watch(target: Document | ShadowRoot): void {
    if (this.#observed.has(target)) return;
    this.#observed.add(target);
    this.#observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
    // Slot assignment changes (light-DOM children of a host) are not tree mutations of the slot.
    target.addEventListener('slotchange', (event) => {
      this.#markPath(event.target as Node);
    });
    // Transitions and animations can change visibility below their element without any mutation.
    const settle = (event: Event): void => {
      this.#markSubtree(event.target as Node);
    };
    target.addEventListener('transitionend', settle, true);
    target.addEventListener('animationend', settle, true);
    if (target.nodeType !== 9) return;
    const doc = target as Document;
    // Media queries may flip on resize: anything can look different.
    doc.defaultView?.addEventListener('resize', () => {
      this.invalidateAll();
    });
    // A (same-origin) iframe that loads a new document changes its parent's contribution.
    doc.addEventListener(
      'load',
      (event) => {
        if ((event.target as Element | null)?.tagName === 'IFRAME') this.#markPath(event.target as Element);
      },
      true,
    );
  }

  #apply(records: readonly MutationRecord[]): void {
    if (records.length > 0) this.#generation++;
    for (const record of records) {
      const target = record.type === 'characterData' ? record.target.parentNode : record.target;
      if (!target) continue;
      if (
        isStyling(target) ||
        Array.from(record.addedNodes).concat(Array.from(record.removedNodes)).some(isStyling)
      ) {
        this.invalidateAll();
        return;
      }
      if (record.type === 'attributes' && !LOCAL_ATTRIBUTES.has(record.attributeName ?? ''))
        this.#markSubtree(target);
      else this.#markPath(target);
    }
  }

  #markSubtree(node: Node): void {
    this.#subtree.add(node);
    this.#markPath(node);
  }

  /**
   * Mark a node and all its ancestors, including the slot it is rendered through. Always walks to the
   * root: stopping at an already-dirty node is wrong when that mark sits below a leaf, whose subtree the
   * builder never visits (fuzzer seed 18).
   */
  #markPath(start: Node, hosts = new Set<Node>()): void {
    this.#generation++;
    for (let node: Node | null = start; node; node = parentOf(node)) {
      this.#dirty.add(node);
      // Light-DOM content renders through the host's slots: those (and their ancestors inside the
      // shadow root) must be rebuilt too. Done via the host so it works without `assignedSlot`;
      // `hosts` stops the walk from a slot back up to its own host from repeating.
      const shadow = (node as Element).shadowRoot;
      if (shadow && !hosts.has(node)) {
        hosts.add(node);
        for (const slot of Array.from(shadow.querySelectorAll('slot'))) this.#markPath(slot, hosts);
      }
    }
  }

  #contribution(node: Node, force: boolean): readonly TreeNode[] {
    if (node.nodeType === 3) return this.#text(node);
    if (node.nodeType !== 1) return [];
    const el = node as Element;
    const forceBelow = force || this.#subtree.has(el);
    const cached = this.#cache.get(el);
    if (cached && !forceBelow && !this.#dirty.has(el)) return cached;
    this.#dirty.delete(el);
    this.#subtree.delete(el);
    const result = this.#compute(el, forceBelow);
    this.#cache.set(el, result);
    return result;
  }

  /**
   * `attachShadow()` produces no mutation record. Custom elements seen without a shadow root (not
   * upgraded yet) are remembered; before each build, any that have gained one are marked dirty with
   * their ancestors, so cached contributions above them cannot hide the new shadow content.
   */
  #checkPendingHosts(): void {
    for (const el of this.#pendingHosts) {
      if (!el.isConnected) {
        this.#pendingHosts.delete(el);
      } else if (el.shadowRoot) {
        this.#pendingHosts.delete(el);
        this.#markSubtree(el);
      }
    }
  }

  #compute(el: Element, force: boolean): readonly TreeNode[] {
    if (el.tagName.includes('-') && !el.shadowRoot) this.#pendingHosts.add(el);
    const visibility = visibilityOf(el);
    if (visibility === 'hidden') return [];
    // `visibility: hidden` hides the element and its own text, but descendants may override it.
    if (visibility === 'self') return this.#children(el, force, false);
    return el.tagName === 'WEBVIEW' ? this.#webview(el) : this.#element(el, force);
  }

  /** An element that is shown: its own line when it has a role, and what renders inside it. */
  #element(el: Element, force: boolean): readonly TreeNode[] {
    const aria = roleOf(el);
    const shown = aria === undefined ? clickableOf(el) : { role: aria, leaf: isLeaf(el, aria) };
    const role = shown?.role;
    // Assign the ref before visiting children so refs follow document order.
    const ref = role === undefined ? undefined : this.#refs.refOf(el);
    const children = shown?.leaf === true ? [] : this.#children(el, force, true);
    if (role === undefined || ref === undefined) return children;
    const crossOrigin = el.tagName === 'IFRAME' && !frameDocument(el);
    const live = isLive(el, role) || nameDependsOnOthers(el);
    const name = shownName(el, role);
    this.#refs.remember(ref, role, name.text);
    const head = headOf(el, role, ref, name) + (crossOrigin ? CROSS_ORIGIN : '');
    return [{ key: `e${ref}`, el, role, ref, head, live, crossOrigin, children }];
  }

  /** A `<webview>`: one line, never its internal frame (that is not a cross-origin iframe of this page). */
  #webview(el: Element): readonly TreeNode[] {
    const ref = this.#refs.refOf(el);
    const name = shownName(el, 'webview');
    this.#refs.remember(ref, 'webview', name.text);
    const head = headOf(el, 'webview', ref, name) + WEBVIEW;
    return [
      { key: `e${ref}`, el, role: 'webview', ref, head, live: false, crossOrigin: false, children: [] },
    ];
  }

  #children(el: Element, force: boolean, withText: boolean): TreeNode[] {
    const nodes: TreeNode[] = [];
    for (const child of this.#childNodes(el)) {
      if (child.nodeType === 3 && !withText) continue;
      nodes.push(...this.#contribution(child, force));
    }
    return nodes;
  }

  /** What renders inside `el`: an iframe's document, a shadow root, slotted nodes, or its children. */
  #childNodes(el: Element): Node[] {
    if (el.tagName === 'IFRAME') {
      const doc = frameDocument(el);
      if (!doc?.body) return [];
      this.#watch(doc);
      return [doc.body];
    }
    if (el.shadowRoot) this.#watch(el.shadowRoot);
    return renderedChildNodes(el);
  }

  #text(node: Node): readonly TreeNode[] {
    const text = clip(node.textContent ?? '', MAX_TEXT);
    const owner = textOwner(node);
    if (text === '' || !owner) return [];
    let id = this.#textIds.get(node);
    if (id === undefined) {
      id = this.#nextText++;
      this.#textIds.set(node, id);
    }
    const head = `text ${JSON.stringify(text)}`;
    return [
      {
        key: `t${id}`,
        el: owner,
        role: undefined,
        ref: undefined,
        head,
        live: false,
        crossOrigin: false,
        children: [],
      },
    ];
  }
}

/** `role "name" [eN] states…: "value"` — the agent-facing line format. */
/**
 * Leaf roles whose element may still hold controls, then shown under it: table cells (an editable grid,
 * row actions), ARIA 1.1 comboboxes (a wrapper around its textbox and listbox), tabs with a close
 * button, options and menu items with actions.
 */
const MAY_HOLD_CONTROLS = new Set([
  'cell',
  'columnheader',
  'rowheader',
  'combobox',
  'tab',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
]);

function isLeaf(el: Element, role: string): boolean {
  if (!LEAF_ROLES.has(role)) return false;
  // A native <select>'s options are its value and choices, never separate controls.
  return el.tagName === 'SELECT' || !MAY_HOLD_CONTROLS.has(role) || !holdsControls(el);
}

export function headOf(el: Element, role: string, ref: number, name: string | ShownName): string {
  const shown = typeof name === 'string' ? { text: name, guessed: false } : name;
  const states = statesOf(el, role);
  const value = valueOf(el, role);
  const valueText =
    value === undefined
      ? ''
      : 'redacted' in value
        ? ': (redacted)'
        : `: ${JSON.stringify(clip(value.value, MAX_TEXT))}`;
  const guessed = shown.guessed ? ' (guessed)' : '';
  return `${role} ${JSON.stringify(shown.text)}${guessed} [e${ref}]${states.length > 0 ? ` ${states.join(' ')}` : ''}${valueText}`;
}

/** Parent across shadow roots and same-origin frame boundaries. */
function parentOf(node: Node): Node | null {
  const parent = node.parentNode;
  // A shadow root's parent (for our purposes) is its host element.
  if (parent?.nodeType === 11) return (parent as ShadowRoot).host;
  if (parent) return parent;
  if (node.nodeType === 9) return (node as Document).defaultView?.frameElement ?? null;
  return null;
}

function frameDocument(el: Element): Document | null {
  try {
    return (el as HTMLIFrameElement).contentDocument;
  } catch {
    return null;
  }
}

function isStyling(node: Node): boolean {
  const tag = (node as Element).tagName;
  return tag === 'STYLE' || (tag === 'LINK' && (node as Element).getAttribute('rel') === 'stylesheet');
}
