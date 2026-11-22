import { z } from 'zod';

import { TargetSelectorSchema } from '../../model/locator.js';
import {
  IpcEventSchema,
  LogEntrySchema,
  NetworkRecordSchema,
  PageParamsShape,
  pageDataSchema,
} from '../../model/records.js';
import type { MethodDef } from '../method-def.js';

/** Reading the bounded event rings. Every result reports how many records were evicted unread. */
export const observeMethods = {
  'ipc.query': {
    params: z.object({
      ...PageParamsShape,
      /** Channel glob (`*` and `?`). */
      channel: z.string().max(256).optional(),
      kind: IpcEventSchema.shape.kind.optional(),
      includeInternal: z.boolean().optional(),
      /** Since protocol 1.1: add each channel's inferred request and response types. */
      schemas: z.boolean().optional(),
    }),
    data: pageDataSchema(IpcEventSchema).extend({
      /** Channels seen so far with counts: the app's IPC surface. */
      channels: z.array(
        z.object({
          channel: z.string(),
          kinds: z.array(z.string()),
          count: z.number().int(),
          /** With `schemas`: types inferred from main-side messages (TypeScript-like), and from how many. */
          schema: z
            .object({
              request: z.string().optional(),
              response: z.string().optional(),
              samples: z.number().int(),
            })
            .optional(),
        }),
      ),
    }),
    capability: 'observe',
  },
  'logs.query': {
    params: z.object({
      ...PageParamsShape,
      source: LogEntrySchema.shape.source.optional(),
      minLevel: LogEntrySchema.shape.level.optional(),
      target: TargetSelectorSchema,
      contains: z.string().max(500).optional(),
    }),
    data: pageDataSchema(LogEntrySchema),
    capability: 'observe',
  },
  'network.query': {
    params: z.object({
      ...PageParamsShape,
      target: TargetSelectorSchema,
      /** URL glob. */
      url: z.string().max(2_000).optional(),
      failedOnly: z.boolean().optional(),
    }),
    data: pageDataSchema(NetworkRecordSchema),
    capability: 'observe',
  },
} as const satisfies Record<string, MethodDef>;
