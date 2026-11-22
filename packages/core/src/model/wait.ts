import { z } from 'zod';

import { LocatorSchema } from './locator.js';

/**
 * What to wait for. Arbitrary page expressions are deliberately absent: they are `eval`, available
 * through `main.eval` only when the app allows it.
 */
export const WaitConditionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('element'),
    locator: LocatorSchema,
    state: z.enum(['attached', 'detached', 'visible', 'hidden', 'enabled']).optional(),
  }),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(500), present: z.boolean().optional() }),
  z.object({ kind: z.literal('url'), contains: z.string().min(1).max(2_000) }),
  z.object({ kind: z.literal('ipc'), channel: z.string().min(1).max(256) }),
  z.object({ kind: z.literal('networkIdle'), idleMs: z.number().int().min(0).max(60_000).optional() }),
  z.object({
    kind: z.literal('state'),
    store: z.string().max(128).optional(),
    path: z.string().max(500),
    /** Compared as JSON with the value as read: redacted (`"[redacted]"`) and bounded like `state.read`. */
    equals: z.unknown().refine((value) => value !== undefined, { message: 'equals is required' }),
  }),
]);
export type WaitCondition = z.infer<typeof WaitConditionSchema>;
