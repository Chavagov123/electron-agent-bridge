import { z } from 'zod';

/** Capability tiers. A session gets the app's ceiling; `eval` is never granted by default. */
export const CapabilitySchema = z.enum(['observe', 'interact', 'eval']);
export type Capability = z.infer<typeof CapabilitySchema>;

/** How a client reached the app: the runtime inside it (integrated, launch) or renderers only (attach). */
export const ConnectionModeSchema = z.enum(['integrated', 'launch', 'attach']);
export type ConnectionMode = z.infer<typeof ConnectionModeSchema>;

/**
 * Feature groups a connection can serve. The in-app runtime serves all of them; attaching to renderers
 * only lacks the main-process ones. Unknown names (from a newer runtime) are kept as plain strings.
 */
export const FEATURES = ['pages', 'ipc', 'mainLogs', 'mainControl', 'state'] as const;
export type Feature = (typeof FEATURES)[number];

/** One protocol method: validated params, the `data` schema of its envelope, and the capability it needs. */
export interface MethodDef {
  readonly params: z.ZodType;
  readonly data: z.ZodType;
  readonly capability: Capability;
}
