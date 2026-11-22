/** Small DOM helpers shared by the tree builder and the name algorithm. */

/** Collapse whitespace and clip to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What renders inside `el` (iframes aside): its open shadow root, a slot's assigned nodes, or its children. */
export function renderedChildNodes(el: Element): Node[] {
  if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes);
  if (el.tagName === 'SLOT') {
    const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
    if (assigned.length > 0) return assigned;
  }
  return Array.from(el.childNodes);
}

/** The element a text node renders in: its parent element, or the host of the shadow root it sits in. */
export function textOwner(node: Node): Element | null {
  if (node.parentElement) return node.parentElement;
  const parent = node.parentNode;
  return parent?.nodeType === 11 ? (parent as ShadowRoot).host : null;
}
