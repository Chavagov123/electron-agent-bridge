import {
  LIMITATION_CODES,
  type Envelope,
  type Limitation,
  type Locator,
  type MethodData,
  type MethodInput,
} from '@electron-agent-bridge/core';
import type { SnapshotResponse } from '@electron-agent-bridge/page-agent';

import type { AgentPool } from '../page/agent-pool.js';
import type { TargetDescriptor } from '../ports/target-source.js';
import { AX_LIMIT, axNames } from './ax-names.js';

/** Snapshot params the snapshotter interprets (the target is resolved by the caller). */
export type SnapshotOptions = Omit<MethodInput<'snapshot.take'>, 'target'>;

const FULL_BECAUSE: Record<NonNullable<SnapshotResponse['fullBecause']>, string> = {
  'unknown-cursor': 'The cursor is unknown or expired (or the page navigated); a full snapshot was returned.',
  'scope-changed':
    'The cursor belongs to a different scope (root/depth/maxLines/fidelity); a full snapshot was returned.',
  'too-many-changes': 'Most of the page changed; a full snapshot was returned instead of a delta.',
};

/**
 * Snapshots and element lookups through the page agent (P5): cached, ref-bearing, delta-capable.
 */
export class AgentSnapshotter {
  readonly #pool: AgentPool;

  constructor(pool: AgentPool) {
    this.#pool = pool;
  }

  async take(
    target: TargetDescriptor,
    options: SnapshotOptions = {},
  ): Promise<Envelope<MethodData<'snapshot.take'>>> {
    const client = this.#pool.clientFor(target);
    const limitations: Limitation[] = [];
    let names: Record<string, string> | undefined;
    if (options.fidelity === 'ax') {
      const ax = await axNames(client, target.transport, options.root);
      names = ax.names;
      if (ax.capped) {
        limitations.push({
          code: LIMITATION_CODES.partial,
          message: `Accessibility-tree names were fetched for the first ${AX_LIMIT} elements only; snapshot a narrower root.`,
        });
      }
    }
    const response = await client.snapshot({
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.since === undefined ? {} : { since: options.since }),
      ...(options.root === undefined ? {} : { root: options.root }),
      ...(options.depth === undefined ? {} : { depth: options.depth }),
      ...(options.maxLines === undefined ? {} : { maxLines: options.maxLines }),
      ...(names === undefined ? {} : { names }),
    });
    limitations.push(...limitationsOf(response));
    return {
      data: {
        target: target.id,
        url: response.url,
        title: response.title,
        kind: response.kind,
        cursor: response.cursor,
        text: response.text,
        lineCount: response.lineCount,
      },
      limitations,
      untrusted: true,
    };
  }

  async find(
    target: TargetDescriptor,
    locator: Locator,
    limit: number,
  ): Promise<Envelope<MethodData<'dom.find'>>> {
    const { matches, total } = await this.#pool.clientFor(target).find(locator, limit);
    const limitations: Limitation[] =
      total > matches.length
        ? [{ code: LIMITATION_CODES.truncated, message: `Showing ${matches.length} of ${total} matches.` }]
        : [];
    return { data: { matches, total }, limitations, untrusted: true };
  }
}

function limitationsOf(response: SnapshotResponse): Limitation[] {
  const limitations: Limitation[] = [];
  if (response.truncated) {
    limitations.push({
      code: LIMITATION_CODES.truncated,
      message: `Output capped at ${response.lineCount} lines; narrow it with root (a ref) or depth.`,
    });
  }
  if (response.collapsed > 0) {
    limitations.push({
      code: LIMITATION_CODES.truncated,
      message: `${response.collapsed} items of long lists were collapsed; expand one with root set to its [expand eN] ref.`,
    });
  }
  if (response.crossOriginFrames > 0) {
    limitations.push({
      code: LIMITATION_CODES.partial,
      message: `${response.crossOriginFrames} cross-origin frame(s) are not included.`,
    });
  }
  if (response.fullBecause) {
    limitations.push({ code: LIMITATION_CODES.fullSnapshot, message: FULL_BECAUSE[response.fullBecause] });
  }
  return limitations;
}
