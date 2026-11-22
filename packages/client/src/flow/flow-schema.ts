import { ActionSchema, LocatorSchema, WaitConditionSchema } from '@eab/core';
import { z } from 'zod';

const Name = z.string().min(1).max(200);
const Target = z.string().min(1).max(128);
/** Same ceiling as the runtime's per-action timeout. */
const Timeout = z.number().int().min(0).max(120_000);

/** Fields every step may carry. */
const Common = {
  name: Name.optional(),
  /** Page for this step (id or name); default: the flow's target, else the focused window. */
  target: Target.optional(),
  timeoutMs: Timeout.optional(),
  /** Record a failure and go on with the next step. */
  continueOnError: z.boolean().optional(),
};

/**
 * What a flow can check. Every check waits up to the step timeout (like Playwright's `expect`), so
 * flows need no sleeps.
 */
export const EXPECTATIONS = {
  element: z.strictObject({
    element: LocatorSchema,
    state: z.enum(['attached', 'detached', 'visible', 'hidden', 'enabled']).optional(),
  }),
  text: z.strictObject({ text: z.string().min(1).max(500), present: z.boolean().optional() }),
  url: z.strictObject({ url: z.strictObject({ contains: z.string().min(1).max(2_000) }) }),
  state: z.strictObject({
    state: z.strictObject({
      store: z.string().max(128).optional(),
      path: z.string().max(500),
      equals: z.unknown().refine((value) => value !== undefined, { message: 'equals is required' }),
    }),
  }),
  /** IPC since the flow started: at least `min` (default 1) messages on the channel glob. */
  ipc: z.strictObject({
    ipc: z.strictObject({ channel: z.string().min(1).max(256), min: z.number().int().min(1).optional() }),
  }),
  /** No renderer errors (console.error, uncaught exceptions) since the flow started. */
  noConsoleErrors: z.strictObject({ noConsoleErrors: z.literal(true) }),
} as const;
export const ExpectationSchema = z.union(Object.values(EXPECTATIONS));
export type Expectation = z.infer<typeof ExpectationSchema>;

/** Step kinds by their key; a step has exactly one of these keys (plus the common fields). */
export const STEPS = {
  act: z.strictObject({ ...Common, act: z.union([ActionSchema, z.array(ActionSchema).min(1).max(50)]) }),
  wait: z.strictObject({ ...Common, wait: WaitConditionSchema }),
  expect: z.strictObject({ ...Common, expect: ExpectationSchema }),
  stub: z.strictObject({
    ...Common,
    stub: z.strictObject({
      method: z.enum(['showOpenDialog', 'showSaveDialog', 'showMessageBox']),
      response: z.record(z.string(), z.unknown()),
      times: z.number().int().min(1).max(100).optional(),
    }),
  }),
  menu: z.strictObject({
    ...Common,
    menu: z.union([z.array(z.string().max(256)).min(1).max(10), z.strictObject({ id: z.string().max(256) })]),
  }),
  window: z.strictObject({
    ...Common,
    window: z.strictObject({
      action: z.enum(['focus', 'show', 'hide', 'minimize', 'maximize', 'restore', 'close', 'setBounds']),
      /** Window id; default: the window of the step's page. */
      id: z.number().int().optional(),
      bounds: z
        .strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .partial()
        .optional(),
    }),
  }),
  /** Undo automation state (focus emulation, dialog stubs). */
  reset: z.strictObject({ ...Common, reset: z.literal(true) }),
  /** Save a screenshot into the artifacts directory. */
  screenshot: z.strictObject({
    ...Common,
    screenshot: z.strictObject({ file: z.string().min(1).max(200).optional() }),
  }),
} as const;
export type StepKind = keyof typeof STEPS;
export const StepSchema = z.union(Object.values(STEPS));
export type FlowStep = z.infer<typeof StepSchema>;

/** How a flow reaches its app: an already running one, or one it launches (and closes afterwards). */
export const FlowAppSchema = z.union([
  z.strictObject({
    connect: z.strictObject({ pid: z.number().int().positive().optional() }),
  }),
  z.strictObject({
    launch: z.strictObject({
      executable: z.string().min(1),
      args: z.array(z.string()).max(100).optional(),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      strategy: z.enum(['auto', 'node-options', 'inspector']).optional(),
      allowPackaged: z.boolean().optional(),
      allowEval: z.boolean().optional(),
      timeoutMs: Timeout.optional(),
    }),
  }),
]);
export type FlowApp = z.infer<typeof FlowAppSchema>;

export const FlowSchema = z.strictObject({
  name: Name,
  description: z.string().max(2_000).optional(),
  /** Default: connect to the newest running app (or the one `--pid` names). */
  app: FlowAppSchema.optional(),
  /** Defaults for every step. */
  target: Target.optional(),
  timeoutMs: Timeout.optional(),
  steps: z.array(StepSchema).min(1).max(500),
});
export type Flow = z.infer<typeof FlowSchema>;
