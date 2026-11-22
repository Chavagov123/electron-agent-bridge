import type { TreeNode } from './tree.js';

/** One rendered line. `parent` is the index of the enclosing line (-1 at top level). */
export interface Line {
  readonly key: string;
  readonly depth: number;
  readonly text: string;
  readonly parent: number;
}

export interface RenderOptions {
  readonly maxLines: number;
  /** Lists longer than this are collapsed to their first `keepChildren` items plus a summary. */
  readonly maxChildren: number;
  readonly keepChildren: number;
  /** Levels shown below the top level; deeper content is summarised. */
  readonly depth: number | undefined;
  /** Ref whose own children are never collapsed (the "expand" target). */
  readonly expand: number | undefined;
  /** The top-level list is the scope the caller asked for: never collapse it. */
  readonly expandTop: boolean;
  /**
   * The previous snapshot's collapsed content (for deltas): items past a list's collapsed point that
   * changed since are revealed, showing only their changed branches, so a change past the collapsed
   * point (a form's tail, row 35) shows without unfolding everything around it.
   */
  readonly previous?: Revealing;
  /**
   * A node's line: its cached head, or a recomputed one for live nodes and name overrides.
   * `undefined` drops the node (a live control that is now hidden). Must stay cheap for cached nodes.
   */
  readonly head: (node: TreeNode) => string | undefined;
}

export interface Rendered {
  readonly lines: Line[];
  readonly truncated: boolean;
  /** Items left out of collapsed lists. */
  readonly collapsed: number;
  readonly crossOriginFrames: number;
  /** What the next delta needs to tell changed collapsed content from unchanged. */
  readonly revealing: Revealing;
}

/**
 * Collapsed content as one render left it. Builds reuse the nodes of unchanged subtrees, so a node
 * that is not among the `hidden` ones is new: it, or something below it, changed.
 */
export interface Revealing {
  /** Nodes not shown: unrevealed items past collapsed points, and unchanged branches of revealed ones. */
  readonly hidden: ReadonlySet<TreeNode>;
  /** Items past collapsed points shown because they changed (they stay shown, so deltas stay quiet). */
  readonly revealed: ReadonlySet<TreeNode>;
}

/** Render nodes to indented lines, bounded by `maxLines`, collapsing long repeated lists. */
export function render(nodes: readonly TreeNode[], options: RenderOptions): Rendered {
  const renderer = new Renderer(options);
  renderer.list(nodes, 0, -1);
  return renderer.result();
}

/** Where a list renders: its owner (none at the top level), and whether only changes are shown. */
interface Place {
  readonly owner?: TreeNode;
  readonly changedOnly?: boolean;
}

class Renderer {
  readonly #options: RenderOptions;
  readonly #lines: Line[] = [];
  #truncated = false;
  #collapsed = 0;
  #crossOriginFrames = 0;
  readonly #hidden = new Set<TreeNode>();
  readonly #revealed = new Set<TreeNode>();

  constructor(options: RenderOptions) {
    this.#options = options;
  }

  result(): Rendered {
    return {
      lines: this.#lines,
      truncated: this.#truncated,
      collapsed: this.#collapsed,
      crossOriginFrames: this.#crossOriginFrames,
      revealing: { hidden: this.#hidden, revealed: this.#revealed },
    };
  }

  /**
   * Children of `owner` (or the top level), collapsing long lists unless `owner` is being expanded.
   * `changedOnly`: inside a revealed item, where only branches that changed are shown.
   */
  list(nodes: readonly TreeNode[], depth: number, parent: number, place: Place = {}): void {
    const collapse = this.#collapses(nodes, place.owner);
    const shown = collapse ? nodes.slice(0, this.#options.keepChildren) : nodes;
    for (const node of shown) {
      if (this.#truncated) return;
      this.#node(node, depth, parent, place.changedOnly === true);
    }
    if (!collapse || this.#truncated) return;
    const rest = this.#tail(nodes.slice(shown.length), depth, parent);
    if (rest === 0 || this.#isTruncated()) return;
    this.#collapsed += rest;
    const owner = place.owner;
    const expand =
      owner?.ref === undefined ? ' (find them, or snapshot a narrower root)' : ` [expand e${owner.ref}]`;
    this.#push({ key: `${owner?.key ?? 'root'}:more`, depth, text: `… ${rest} more${expand}`, parent });
  }

  /** Long lists fold, except an expanded one; the top level has no ref to expand it by, so only a repeated list folds there. */
  #collapses(nodes: readonly TreeNode[], owner: TreeNode | undefined): boolean {
    if (nodes.length <= this.#options.maxChildren || this.#expanded(owner)) return false;
    return owner !== undefined || repeated(nodes);
  }

  #expanded(owner: TreeNode | undefined): boolean {
    if (owner === undefined) return this.#options.expandTop;
    return owner.ref !== undefined && owner.ref === this.#options.expand;
  }

  /** A method, not the field: rendering a tail can set it after the caller's own check. */
  #isTruncated(): boolean {
    return this.#truncated;
  }

  /** The items past the collapsed point: the revealed ones are shown; returns how many stay hidden. */
  #tail(nodes: readonly TreeNode[], depth: number, parent: number): number {
    const previous = this.#options.previous;
    let hidden = 0;
    for (const node of nodes) {
      if (previous !== undefined && (previous.revealed.has(node) || !previous.hidden.has(node))) {
        this.#revealed.add(node);
        this.#node(node, depth, parent, true);
      } else {
        hidden++;
        this.#hide(node);
      }
    }
    return hidden;
  }

  #hide(node: TreeNode): void {
    this.#hidden.add(node);
    for (const child of node.children) this.#hide(child);
  }

  #node(node: TreeNode, depth: number, parent: number, changedOnly: boolean): void {
    const text = this.#options.head(node);
    if (text === undefined) return;
    if (node.crossOrigin) this.#crossOriginFrames++;
    if (!this.#push({ key: node.key, depth, text, parent })) return;
    // In a revealed item, branches hidden before and unchanged since stay hidden.
    const previous = changedOnly ? this.#options.previous : undefined;
    const children = previous
      ? node.children.filter((child) => {
          if (!previous.hidden.has(child)) return true;
          this.#hide(child);
          return false;
        })
      : node.children;
    if (children.length === 0) return;
    const index = this.#lines.length - 1;
    const limit = this.#options.depth;
    if (limit !== undefined && depth >= limit) {
      const text = `… ${children.length} more below`;
      this.#push({ key: `${node.key}:deep`, depth: depth + 1, text, parent: index });
      return;
    }
    this.list(children, depth + 1, index, { owner: node, changedOnly });
  }

  #push(line: Line): boolean {
    if (this.#lines.length >= this.#options.maxLines) {
      this.#truncated = true;
      return false;
    }
    this.#lines.push(line);
    return true;
  }
}

/** `  - text` with two spaces per level. */
export function formatLine(line: Line): string {
  return `${'  '.repeat(line.depth)}- ${line.text}`;
}

/** Share of a list that must have one role for it to count as repeated (rows, cards, results). */
const REPEATED_SHARE = 0.75;

/** Whether most items of a list have the same role: a list of like things, not a page's sections. */
function repeated(nodes: readonly TreeNode[]): boolean {
  const counts = new Map<string, number>();
  let most = 0;
  for (const node of nodes) {
    const role = node.role ?? 'text';
    const count = (counts.get(role) ?? 0) + 1;
    counts.set(role, count);
    most = Math.max(most, count);
  }
  return most >= nodes.length * REPEATED_SHARE;
}
