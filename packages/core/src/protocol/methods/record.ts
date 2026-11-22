import { z } from 'zod';

import { ActionSchema } from '../../model/action.js';
import { PageParamsShape, pageDataSchema } from '../../model/records.js';
import type { MethodDef } from '../method-def.js';

/**
 * One recorded action (protocol 1.1): what a user did in a page, or what an agent ran through
 * `action.run`, with a locator that outlives refs (role and exact name, text, or CSS).
 */
export const RecordedEventSchema = z.object({
  seq: z.number().int(),
  ts: z.number(),
  /** The page's target id (shown by name). */
  target: z.string(),
  source: z.enum(['user', 'agent']),
  action: ActionSchema,
  /** URL of the page when it happened. */
  url: z.string().optional(),
  /** A password field: its value was not recorded (a flow should take it from the environment). */
  secret: z.boolean().optional(),
});
export type RecordedEvent = z.infer<typeof RecordedEventSchema>;

/** Recording what users and agents do, to turn it into a flow (protocol 1.1). Observers may record. */
export const recordMethods = {
  'record.start': {
    params: z.object({}),
    data: z.object({ recording: z.literal(true), nextSeq: z.number().int() }),
    capability: 'observe',
  },
  'record.stop': {
    params: z.object({}),
    data: z.object({ recording: z.literal(false) }),
    capability: 'observe',
  },
  'record.events': {
    params: z.object({ ...PageParamsShape }),
    data: pageDataSchema(RecordedEventSchema).extend({ recording: z.boolean() }),
    capability: 'observe',
  },
} as const satisfies Record<string, MethodDef>;
