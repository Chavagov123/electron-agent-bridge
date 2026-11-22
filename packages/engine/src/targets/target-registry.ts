import type { TargetDescriptor, TargetSource } from '../ports/target-source.js';
import { baseName, uniqueName } from './naming.js';
import { resolveTarget } from './resolve-target.js';

/** A target with its stable, unique name. */
export interface NamedTarget extends TargetDescriptor {
  readonly name: string;
}

interface Assigned {
  readonly name: string;
  /** The app's explicit name this was assigned from, if any. */
  readonly hint: string | undefined;
}

/**
 * Gives every target a human-friendly name that stays the same for its whole life (agents keep using
 * `settings` even after the page navigates or retitles), and resolves selectors by id or name.
 *
 * - The app's explicit name always wins: a derived name in the way is moved aside.
 * - Derived names are frozen only once the page has finished loading (titles arrive late).
 * - Names never collide with each other or with any live target's id; closed targets release theirs.
 */
export class TargetRegistry {
  readonly #source: TargetSource;
  readonly #assigned = new Map<string, Assigned>();

  constructor(source: TargetSource) {
    this.#source = source;
  }

  list(): NamedTarget[] {
    const live = this.#source.list();
    const liveIds = new Set(live.map((target) => target.id));
    for (const id of this.#assigned.keys()) if (!liveIds.has(id)) this.#assigned.delete(id);
    // Explicit names first, so they take precedence over derived ones in this pass.
    const ordered = [...live].sort(
      (a, b) => Number(b.nameHint !== undefined) - Number(a.nameHint !== undefined),
    );
    const names = new Map<string, string>();
    for (const target of ordered) names.set(target.id, this.#nameFor(target, liveIds, names));
    return live.map((target) => ({ ...target, name: names.get(target.id) ?? target.id }));
  }

  /** The target for `selector` (id or name), or the default target when omitted. */
  resolve(selector?: string): NamedTarget {
    return resolveTarget(this.list(), selector);
  }

  #nameFor(
    target: TargetDescriptor,
    liveIds: ReadonlySet<string>,
    pass: ReadonlyMap<string, string>,
  ): string {
    const current = this.#assigned.get(target.id);
    const stale = target.nameHint !== undefined && current?.hint !== target.nameHint;
    if (current && !stale) return current.name;
    const base = baseName(target);
    // Nothing to be named after yet: use the id for now, decide later.
    if (base === undefined) return target.id;
    if (target.nameHint !== undefined) this.#evictDerived(base, target.id);
    const taken = new Set<string>([...liveIds].filter((id) => id !== target.id));
    for (const [id, entry] of this.#assigned) if (id !== target.id) taken.add(entry.name);
    for (const [id, name] of pass) if (id !== target.id) taken.add(name);
    const name = uniqueName(base, taken);
    // A page still loading may not have its real title yet: name it provisionally.
    if (target.loading !== true || target.nameHint !== undefined) {
      this.#assigned.set(target.id, { name, hint: target.nameHint });
    }
    return name;
  }

  /** Free `name` from a target that only derived it, so an explicit name can take it. */
  #evictDerived(name: string, claimant: string): void {
    for (const [id, entry] of this.#assigned) {
      if (id !== claimant && entry.name === name && entry.hint === undefined) this.#assigned.delete(id);
    }
  }
}
