import { clip, renderedChildNodes } from './dom.js';
import { NAME_FROM_CONTENT, isHidden, roleOf } from './semantics.js';

/** Names longer than this are clipped with an ellipsis: they identify, they do not transcribe. */
export const MAX_NAME = 80;

interface Walk {
  /** Elements already on the path (cycles through aria-labelledby). */
  readonly visited: Set<Element>;
  /** Inside an aria-labelledby traversal: hidden referenced nodes still count, no further labelledby. */
  readonly viaLabelledBy: boolean;
  /** Computing the name of an ancestor from its content. */
  readonly inContent: boolean;
  /** Name hidden elements as if shown (locating elements that are not rendered right now). */
  readonly asIfShown: boolean;
}

/**
 * Accessible name, following the practical core of the W3C accname algorithm: aria-labelledby,
 * aria-label, native labels (label, alt, legend, caption, button values), name from content for
 * roles that allow it, then title/placeholder. Whitespace is collapsed and the result clipped.
 */
export function accessibleName(el: Element, role: string | undefined = roleOf(el)): string {
  const name = compute(el, role, {
    visited: new Set(),
    viaLabelledBy: false,
    inContent: false,
    asIfShown: false,
  });
  return clip(name, MAX_NAME);
}

/** The name an element has when shown, even while it (or its content) is hidden. */
export function nameAsIfShown(el: Element, role: string | undefined = roleOf(el)): string {
  const name = compute(el, role, {
    visited: new Set(),
    viaLabelledBy: false,
    inContent: false,
    asIfShown: true,
  });
  return clip(name, MAX_NAME);
}

/** Whether this element's name depends on other elements (so it cannot be cached with its subtree). */
export function nameDependsOnOthers(el: Element): boolean {
  if (el.hasAttribute('aria-labelledby')) return true;
  const labels = (el as HTMLInputElement).labels as NodeListOf<HTMLLabelElement> | null | undefined;
  return labels !== null && labels !== undefined && labels.length > 0;
}

function compute(el: Element, role: string | undefined, walk: Walk): string {
  if (walk.visited.has(el)) return '';
  walk.visited.add(el);
  if (!walk.viaLabelledBy && !walk.asIfShown && isHidden(el)) return '';
  return authorName(el, walk) || hostName(el, role, walk) || tooltipName(el);
}

/** Steps 2B–2C: aria-labelledby (not when already following one), then aria-label. */
function authorName(el: Element, walk: Walk): string {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy && !walk.viaLabelledBy) {
    const text = referenced(el, labelledBy, walk);
    if (text) return text;
  }
  return el.getAttribute('aria-label')?.trim() ?? '';
}

/** Steps 2D–2F: embedded control values, native labels, name from content. */
function hostName(el: Element, role: string | undefined, walk: Walk): string {
  // Inside an ancestor's content, an embedded control contributes its value.
  const embedded = walk.inContent ? embeddedValue(el, role) : undefined;
  if (embedded !== undefined) return embedded;
  const native = nativeName(el, walk);
  if (native) return native;
  const fromChildren =
    walk.inContent || walk.viaLabelledBy || (role !== undefined && NAME_FROM_CONTENT.has(role));
  return fromChildren ? fromContent(el, walk) : '';
}

/** Step 2I: title, then placeholder as a last resort. */
function tooltipName(el: Element): string {
  const title = el.getAttribute('title')?.trim();
  if (title) return title;
  return el.getAttribute('placeholder')?.trim() ?? '';
}

function referenced(el: Element, ids: string, walk: Walk): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  return ids
    .split(/\s+/)
    .map((id) => root.getElementById(id))
    .filter((target): target is HTMLElement => target !== null)
    .map((target) => compute(target, roleOf(target), { ...walk, viaLabelledBy: true, inContent: true }))
    .join(' ')
    .trim();
}

function nativeName(el: Element, walk: Walk): string {
  const tag = el.tagName;
  if (tag === 'INPUT') return inputName(el as HTMLInputElement, walk);
  if (tag === 'IMG' || tag === 'AREA') return el.getAttribute('alt')?.trim() ?? '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return labelText(el, walk);
  if (tag === 'FIELDSET') return childText(el, 'LEGEND', walk);
  if (tag === 'TABLE') return childText(el, 'CAPTION', walk);
  if (tag === 'FIGURE') return childText(el, 'FIGCAPTION', walk);
  return '';
}

function inputName(input: HTMLInputElement, walk: Walk): string {
  const type = input.type;
  if (type === 'button' || type === 'submit' || type === 'reset') {
    if (input.value !== '') return input.value;
    return type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '';
  }
  if (type === 'image') {
    const alt = input.getAttribute('alt')?.trim();
    return alt === undefined || alt === '' ? 'Submit' : alt;
  }
  return labelText(input, walk);
}

/** Text of the element's <label>s, excluding the labelled control itself. */
function labelText(el: Element, walk: Walk): string {
  const labels = (el as HTMLInputElement).labels as NodeListOf<HTMLLabelElement> | null | undefined;
  if (!labels || labels.length === 0) return '';
  return Array.from(labels, (label) => fromContent(label, { ...walk, inContent: true }, el))
    .join(' ')
    .trim();
}

function childText(el: Element, tag: string, walk: Walk): string {
  const child = Array.from(el.children).find((candidate) => candidate.tagName === tag);
  return child ? fromContent(child, { ...walk, inContent: true }) : '';
}

/** Concatenate the names of the element's rendered descendants. `skip` is the labelled control. */
function fromContent(el: Element, walk: Walk, skip?: Element): string {
  const parts: string[] = [];
  for (const child of renderedChildNodes(el)) {
    if (child.nodeType === 3) {
      parts.push(child.textContent ?? '');
    } else if (child.nodeType === 1 && child !== skip) {
      const element = child as Element;
      const part = compute(element, roleOf(element), { ...walk, inContent: true });
      parts.push(isInline(element) ? part : ` ${part} `);
    }
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function embeddedValue(el: Element, role: string | undefined): string | undefined {
  if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton' || role === 'slider') {
    const input = el as HTMLInputElement;
    // A password never contributes to anyone's name (it would leak through labels and aria-labelledby).
    return input.type === 'password' ? '' : input.value;
  }
  if (el.tagName === 'SELECT') return (el as HTMLSelectElement).selectedOptions[0]?.textContent.trim() ?? '';
  return undefined;
}

const INLINE = new Set([
  'A',
  'B',
  'I',
  'EM',
  'STRONG',
  'SPAN',
  'CODE',
  'SMALL',
  'SUB',
  'SUP',
  'ABBR',
  'LABEL',
  'MARK',
  'U',
  'S',
]);

function isInline(el: Element): boolean {
  return INLINE.has(el.tagName);
}
