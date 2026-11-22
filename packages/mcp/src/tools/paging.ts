import { z } from 'zod';

import type { ToolContext } from './tool.js';

/** Paging fields shared by the record tools (logs, network, ipc). */
export const pagingShape = {
  newOnly: z
    .boolean()
    .optional()
    .describe('Only records added since your last call of this tool with the same filters.'),
  since: z.number().int().min(0).optional().describe('Records after this seq (from a previous "next seq").'),
  limit: z.number().int().min(1).max(500).optional().describe('Default 100.'),
};

interface PagingInput {
  readonly newOnly?: boolean | undefined;
  readonly since?: number | undefined;
  readonly limit?: number | undefined;
}

interface PageData {
  readonly nextSeq: number;
  readonly dropped: number;
  readonly more: boolean;
}

/**
 * Query one page of records. With `newOnly`, continue from the seq remembered for this app, tool and
 * filter set; the new position is remembered after every call.
 */
export async function queryPage<R extends { readonly data: PageData }>(
  context: ToolContext,
  scope: string,
  input: PagingInput,
  query: (paging: { since?: number; limit: number }) => Promise<R>,
): Promise<R> {
  const remembered = context.cursors.get(scope);
  const continued = input.newOnly === true && remembered !== undefined ? Number(remembered) : undefined;
  const since = input.since ?? continued;
  const result = await query({ ...(since === undefined ? {} : { since }), limit: input.limit ?? 100 });
  context.cursors.set(scope, String(result.data.nextSeq));
  return result;
}

const PAGING_KEYS: ReadonlySet<string> = new Set(['newOnly', 'since', 'limit']);

/** The filter fields of a paged tool's input (no paging fields, no `undefined`s): the query scope. */
export function filtersOf<T extends PagingInput>(
  input: T,
): { [K in Exclude<keyof T, keyof PagingInput>]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(input).filter(([key, value]) => !PAGING_KEYS.has(key) && value !== undefined),
  ) as { [K in Exclude<keyof T, keyof PagingInput>]?: Exclude<T[K], undefined> };
}

/** `next seq` plus what was evicted unread and whether more records are waiting. */
export function pageFooter(data: PageData): string {
  const notes = [`next seq: ${data.nextSeq}`];
  if (data.more) notes.push('more records are waiting: call again with newOnly or since');
  if (data.dropped > 0) notes.push(`${data.dropped} older record(s) were evicted before they were read`);
  return notes.join('; ');
}
