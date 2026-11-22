import type { Locator } from '@eab/core';

import { createActionApi, type ActionApi } from './action-api.js';
import { diffLines } from './delta.js';
import { AgentFailure, guard, type AgentResult } from './failure.js';
import { describeMatches, resolveLocator, type Match } from './find.js';
import { RECORD_BINDING, locatorFor, startRecording } from './record.js';
import { parseRef, RefTable } from './refs.js';
import { formatLine, render, type Line, type Rendered, type Revealing } from './render.js';
import { TreeBuilder, type TreeNode } from './tree.js';

/** What the engine asks for. Mirrors `snapshot.take` params minus the target. */
export interface SnapshotRequest {
  readonly mode?: 'full' | 'delta';
  readonly since?: string;
  readonly root?: Locator;
  readonly depth?: number;
  readonly maxLines?: number;
  /** Accessible names from Chromium's accessibility tree, by ref (fidelity `ax`). */
  readonly names?: Readonly<Record<string, string>>;
  /** Bypass every cache (verification). */
  readonly fresh?: boolean;
}

export interface SnapshotResponse {
  readonly kind: 'full' | 'delta' | 'unchanged';
  readonly cursor: string;
  readonly text: string;
  readonly lineCount: number;
  readonly truncated: boolean;
  readonly collapsed: number;
  readonly crossOriginFrames: number;
  readonly url: string;
  readonly title: string;
  /** Why a requested delta came back as a full snapshot. */
  readonly fullBecause?: 'unknown-cursor' | 'scope-changed' | 'too-many-changes';
}

export type { AgentResult } from './failure.js';

/** The agent installed as `__eab` in the page's isolated world. All results are plain JSON. */
export interface PageAgent extends ActionApi {
  readonly version: string;
  snapshot(request: SnapshotRequest): AgentResult<SnapshotResponse>;
  find(locator: Locator, limit: number): AgentResult<{ matches: Match[]; total: number }>;
  /** Element for a ref (returned by reference, for CDP calls that need a node). */
  element(ref: string): Element | null;
  /** Refs in the page (or `root`) tree, document order (fidelity `ax` asks Chromium for their names). */
  refs(limit: number, root?: Locator): AgentResult<string[]>;
  /** The most stable locator for a ref's element (recorded flows outlive refs). */
  locatorFor(ref: string): AgentResult<Locator>;
  /** Report user actions to the engine's recording binding; `false` when there is none. */
  recordStart(): AgentResult<boolean>;
  recordStop(): AgentResult<boolean>;
}

const DEFAULTS = { maxLines: 2_000, maxChildren: 30, keepChildren: 20 } as const;
/** Deltas larger than this fraction of the full snapshot are sent as full snapshots instead. */
const DELTA_LIMIT = 0.6;
/** Cursors remembered for deltas. */
const HISTORY = 4;

/** Create the agent for one document (one isolated world). */
export function createAgent(win: Window, version = 'dev'): PageAgent {
  const doc = win.document;
  const refs = new RefTable();
  const builder = new TreeBuilder(refs, doc);
  const token = Math.random().toString(36).slice(2, 8);
  const history = new Map<string, Remembered>();
  let sequence = 0;

  // `body` is missing for documents without one (e.g. bare XML), despite the DOM typings.
  const body = (): Element | null => doc.querySelector('body');
  const pageNodes = (): readonly TreeNode[] => {
    const root = body();
    return root ? builder.build(root) : [];
  };
  /** A node's current line: cheap for cached nodes, recomputed for live ones. */
  const currentHead = (node: TreeNode): string | undefined => (node.live ? builder.head(node) : node.head);
  const findContext = {
    doc,
    refs,
    nodes: pageNodes,
    head: currentHead,
    generation: () => builder.generation(),
  };

  /** The element a scoped request is about; one match is required unless `nth` picks one. */
  const scopeOf = (root: Locator | undefined): Element | null => {
    if (!root) return body();
    const matches = resolveLocator(root, findContext);
    if (matches.length === 0) throw new AgentFailure('NOT_FOUND', 'snapshot root not found');
    if (matches.length > 1) {
      throw new AgentFailure(
        'AMBIGUOUS',
        `${matches.length} elements match the snapshot root; add nth or use a ref`,
      );
    }
    return matches[0] ?? null;
  };

  const renderScope = (request: SnapshotRequest, previous: Remembered | undefined): Rendered => {
    const scope = scopeOf(request.root);
    const names = request.names;
    return render(scope ? builder.build(scope, request.fresh) : [], {
      maxLines: request.maxLines ?? DEFAULTS.maxLines,
      maxChildren: DEFAULTS.maxChildren,
      keepChildren: DEFAULTS.keepChildren,
      depth: request.depth,
      expand: request.root?.ref === undefined ? undefined : parseRef(request.root.ref),
      expandTop: request.root !== undefined,
      ...(previous ? { previous: previous.revealing } : {}),
      head: (node) => {
        const override = node.ref === undefined ? undefined : names?.[`e${node.ref}`];
        return override === undefined ? currentHead(node) : builder.head(node, override);
      },
    });
  };

  const snapshot = (request: SnapshotRequest): SnapshotResponse => {
    const signature = signatureOf(request);
    // Look the previous cursor up before remembering the new one, which may evict it.
    const previous = request.since === undefined ? undefined : history.get(request.since);
    const comparable = previous?.signature === signature && request.mode === 'delta' ? previous : undefined;
    const rendered = renderScope(request, comparable);
    const cursor = `${token}.${++sequence}`;
    remember(history, cursor, { signature, lines: rendered.lines, revealing: rendered.revealing });
    const base = {
      cursor,
      lineCount: rendered.lines.length,
      truncated: rendered.truncated,
      collapsed: rendered.collapsed,
      crossOriginFrames: rendered.crossOriginFrames,
      url: doc.URL,
      title: doc.title,
    };
    const full = { ...base, kind: 'full' as const, text: rendered.lines.map(formatLine).join('\n') };
    if (request.mode !== 'delta' || request.since === undefined) return full;
    if (!previous) return { ...full, fullBecause: 'unknown-cursor' };
    if (previous.signature !== signature) return { ...full, fullBecause: 'scope-changed' };
    const delta = diffLines(previous.lines, rendered.lines);
    if (delta.changes === 0) return { ...base, kind: 'unchanged', text: '' };
    const tooMany = delta.changes > DELTA_LIMIT * Math.max(1, rendered.lines.length);
    return tooMany
      ? { ...full, fullBecause: 'too-many-changes' }
      : { ...base, kind: 'delta', text: delta.text };
  };

  let stopRecording: (() => void) | undefined;
  const recordStart = (): boolean => {
    const binding = (globalThis as Record<string, unknown>)[RECORD_BINDING];
    if (typeof binding !== 'function') return false;
    stopRecording ??= startRecording(win, findContext, (payload) => {
      (binding as (payload: string) => void)(payload);
    });
    return true;
  };

  return {
    ...createActionApi(win, findContext),
    version,
    locatorFor: (ref) =>
      guard(() => {
        const id = parseRef(ref);
        const el = id === undefined ? undefined : refs.element(id);
        if (el === undefined) throw new AgentFailure('STALE_REF', `${ref} is not in the page any more`);
        return locatorFor(el, findContext);
      }),
    recordStart: () => guard(recordStart),
    recordStop: () =>
      guard(() => {
        const was = stopRecording !== undefined;
        stopRecording?.();
        stopRecording = undefined;
        return was;
      }),
    snapshot: (request) => guard(() => snapshot(request)),
    find: (locator, limit) =>
      guard(() => {
        const elements = resolveLocator(locator, findContext);
        return { matches: describeMatches(elements, refs, limit), total: elements.length };
      }),
    element: (ref) => {
      const id = parseRef(ref);
      return id === undefined ? null : (refs.element(id) ?? null);
    },
    refs: (limit, root) =>
      guard(() => {
        const out: string[] = [];
        const visit = (nodes: readonly TreeNode[]): void => {
          for (const node of nodes) {
            if (out.length >= limit) return;
            if (node.ref !== undefined) out.push(`e${node.ref}`);
            visit(node.children);
          }
        };
        const scope = scopeOf(root);
        visit(scope ? builder.build(scope) : []);
        return out;
      }),
  };
}

/** A snapshot as deltas need it: its lines, and its collapsed content (to tell what changed since). */
interface Remembered {
  readonly signature: string;
  readonly lines: Line[];
  readonly revealing: Revealing;
}

/** Deltas are only comparable between renders of the same scope and fidelity. */
function signatureOf(request: SnapshotRequest): string {
  return JSON.stringify([
    request.root ?? null,
    request.depth ?? null,
    request.maxLines ?? null,
    request.names ? 'ax' : 'dom',
  ]);
}

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  while (map.size > HISTORY) {
    const oldest = map.keys().next();
    if (oldest.done === true) return;
    map.delete(oldest.value);
  }
}
