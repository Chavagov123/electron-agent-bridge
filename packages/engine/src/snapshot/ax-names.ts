import type { Locator } from '@electron-agent-bridge/core';
import { z } from 'zod';

import type { PageAgentClient } from '../page/page-agent-client.js';
import type { CdpTransport } from '../ports/cdp-transport.js';

/** Elements looked up in Chromium's accessibility tree per snapshot (each costs two CDP calls). */
export const AX_LIMIT = 1_500;
const BATCH = 100;

const PartialAxTree = z.object({
  nodes: z.array(
    z.object({
      ignored: z.boolean().optional(),
      name: z.object({ value: z.unknown().optional() }).optional(),
    }),
  ),
});

export interface AxNames {
  readonly names: Record<string, string>;
  /** More elements than {@link AX_LIMIT}: the rest keep the agent's own names. */
  readonly capped: boolean;
}

/**
 * Accessible names as Chromium computes them (fidelity `ax`): exact, but slower than the agent's
 * own algorithm. Looks up each ref's element (of the scope only) through `Accessibility.getPartialAXTree`.
 */
export async function axNames(
  client: PageAgentClient,
  transport: CdpTransport,
  root?: Locator,
): Promise<AxNames> {
  const all = await client.refs(AX_LIMIT + 1, root);
  const refs = all.slice(0, AX_LIMIT);
  client.ensure('Accessibility.enable');
  const names: Record<string, string> = {};
  await client.withElements(refs, async (objectIds) => {
    for (let start = 0; start < refs.length; start += BATCH) {
      const batch = refs.slice(start, start + BATCH);
      await Promise.all(
        batch.map(async (ref, offset) => {
          const objectId = objectIds[start + offset];
          if (objectId === undefined) return;
          const name = await nameOf(transport, objectId);
          if (name !== undefined) names[ref] = name;
        }),
      );
    }
  });
  return { names, capped: all.length > AX_LIMIT };
}

async function nameOf(transport: CdpTransport, objectId: string): Promise<string | undefined> {
  try {
    const tree = PartialAxTree.parse(
      await transport.send('Accessibility.getPartialAXTree', { objectId, fetchRelatives: false }),
    );
    const node = tree.nodes.find((candidate) => candidate.ignored !== true) ?? tree.nodes[0];
    const value = node?.name?.value;
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : undefined;
  } catch {
    // Element gone or not in the tree: keep the agent's name.
    return undefined;
  }
}
