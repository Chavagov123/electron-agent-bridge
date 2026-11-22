import { z } from 'zod';

import { LocatorSchema } from './locator.js';

const Modifier = z.enum(['Alt', 'Control', 'Meta', 'Shift']);
const Text = z.string().max(100_000);

/** One user-level interaction. Trusted input via CDP wherever possible (ADR-0008). */
export const ActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('click'),
    locator: LocatorSchema,
    button: z.enum(['left', 'right', 'middle']).optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
    modifiers: z.array(Modifier).max(4).optional(),
  }),
  z.object({ type: z.literal('hover'), locator: LocatorSchema }),
  /** Replace the field's value. */
  z.object({ type: z.literal('fill'), locator: LocatorSchema, value: Text }),
  /** Fill several fields in one step (forms). Booleans check/uncheck, arrays select. */
  z.object({
    type: z.literal('fillForm'),
    fields: z
      .array(
        z.object({
          locator: LocatorSchema,
          value: z.union([Text, z.boolean(), z.array(z.string().max(1_000)).max(100)]),
        }),
      )
      .min(1)
      .max(100),
  }),
  /** Insert text at the focus (or into `locator` after focusing it), without clearing. */
  z.object({ type: z.literal('type'), locator: LocatorSchema.optional(), text: Text }),
  /** Key or chord, e.g. `Enter`, `Control+S`, `Meta+Shift+P`. */
  z.object({ type: z.literal('press'), key: z.string().min(1).max(64), locator: LocatorSchema.optional() }),
  z.object({ type: z.literal('check'), locator: LocatorSchema }),
  z.object({ type: z.literal('uncheck'), locator: LocatorSchema }),
  z.object({
    type: z.literal('select'),
    locator: LocatorSchema,
    values: z.array(z.string().max(1_000)).min(1).max(100),
  }),
  z.object({
    type: z.literal('scroll'),
    locator: LocatorSchema.optional(),
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
  }),
  /** Absolute file paths on the app's machine. */
  z.object({
    type: z.literal('upload'),
    locator: LocatorSchema,
    files: z.array(z.string().min(1).max(4_096)).min(1).max(50),
  }),
  z.object({ type: z.literal('drag'), from: LocatorSchema, to: LocatorSchema }),
]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionType = Action['type'];

/** What the app did in response to an action: the effect side of the cause→effect trace. */
export const ObservationsSchema = z.object({
  dialogs: z.array(z.string()),
  toasts: z.array(z.string()),
  consoleErrors: z.array(z.string()),
  failedRequests: z.array(z.string()),
  ipc: z.array(z.object({ channel: z.string(), kind: z.string(), seq: z.number().int() })),
  navigation: z.object({ url: z.string() }).optional(),
});
export type Observations = z.infer<typeof ObservationsSchema>;

/** The element a step acted on, as the page agent resolved it (refs last for one page load). */
export const ResolvedElementSchema = z.object({ ref: z.string(), role: z.string(), name: z.string() });
export type ResolvedElement = z.infer<typeof ResolvedElementSchema>;

/** Outcome of one step of `action.run`. */
export const StepResultSchema = z.object({
  type: z.string(),
  ok: z.boolean(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
  /** Time to perform the action (budget: 100 ms) and, separately, to let the app settle. */
  timings: z.object({ actionMs: z.number(), settleMs: z.number() }),
  /** Since protocol 1.1: the elements the step acted on, in order (drag: from, to; fillForm: each field). */
  resolved: z.array(ResolvedElementSchema).max(50).optional(),
});
export type StepResult = z.infer<typeof StepResultSchema>;
