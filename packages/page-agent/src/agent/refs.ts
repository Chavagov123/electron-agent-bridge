/**
 * Element refs (`e12`): assigned on first sight, stable for the element's life in this world, never
 * reused. Elements are held weakly; a ref whose element is gone or detached resolves to nothing.
 */
export class RefTable {
  readonly #ids = new WeakMap<Element, number>();
  readonly #elements = new Map<number, WeakRef<Element>>();
  readonly #known = new Map<number, { readonly role: string; readonly name: string }>();
  #next = 1;

  refOf(el: Element): number {
    let id = this.#ids.get(el);
    if (id === undefined) {
      id = this.#next++;
      this.#ids.set(el, id);
      this.#elements.set(id, new WeakRef(el));
      if (this.#elements.size > 50_000 && id % 10_000 === 0) this.#sweep();
    }
    return id;
  }

  /** Remember what a ref looked like, so a stale ref can be healed to an identical replacement. */
  remember(id: number, role: string, name: string): void {
    this.#known.set(id, { role, name });
    if (this.#known.size > 50_000) this.#known.delete(this.#known.keys().next().value ?? id);
  }

  /** The role and name a ref had when it was last rendered. */
  lastKnown(id: number): { readonly role: string; readonly name: string } | undefined {
    return this.#known.get(id);
  }

  /**
   * Refs that are gone now and had this role and name when last rendered. Healing is only safe when
   * the stale ref is the only one: several gone `button "Delete"` refs (one per row) cannot be told apart.
   */
  goneWith(role: string, name: string): number {
    let count = 0;
    for (const [id, known] of this.#known) {
      if (known.role === role && known.name === name && this.element(id) === undefined) count++;
    }
    return count;
  }

  /** The live element for a ref, if it still exists and is in a document. */
  element(id: number): Element | undefined {
    const el = this.#elements.get(id)?.deref();
    return el?.isConnected ? el : undefined;
  }

  #sweep(): void {
    for (const [id, ref] of this.#elements) if (ref.deref() === undefined) this.#elements.delete(id);
  }
}

/** Parse `e12` (a `f2:` prefix from older clients is accepted and ignored: refs are unique per page). */
export function parseRef(ref: string): number | undefined {
  const match = /^(?:f\d+:)?e(\d+)$/.exec(ref);
  return match ? Number(match[1]) : undefined;
}
