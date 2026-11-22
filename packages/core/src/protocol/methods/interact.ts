import { z } from 'zod';

import { ActionSchema, ObservationsSchema, StepResultSchema } from '../../model/action.js';
import { TargetSelectorSchema } from '../../model/locator.js';
import { WaitConditionSchema } from '../../model/wait.js';
import type { MethodDef } from '../method-def.js';

/** Doing things and waiting for their effects. */
export const interactMethods = {
  /** Run one or more actions in order; stops at the first failure unless `continueOnError`. */
  'action.run': {
    params: z.object({
      target: TargetSelectorSchema,
      actions: z.array(ActionSchema).min(1).max(50),
      /** Per-step timeout for actionability (visible, enabled, stable, hit-testable). */
      timeoutMs: z.number().int().min(0).max(120_000).optional(),
      continueOnError: z.boolean().optional(),
      /** Include a snapshot delta of what changed. Default true. */
      delta: z.boolean().optional(),
    }),
    data: z.object({
      steps: z.array(StepResultSchema),
      observations: ObservationsSchema,
      delta: z.string().optional(),
      cursor: z.string().optional(),
    }),
    capability: 'interact',
  },
  'wait.for': {
    params: z.object({
      target: TargetSelectorSchema,
      condition: WaitConditionSchema,
      timeoutMs: z.number().int().min(0).max(300_000).optional(),
    }),
    data: z.object({
      elapsedMs: z.number(),
      /** What was observed when the condition became true. */
      observed: z.string().optional(),
    }),
    capability: 'observe',
  },
} as const satisfies Record<string, MethodDef>;
