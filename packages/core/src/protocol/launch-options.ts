import { z } from 'zod';

/** Environment variable a launcher uses to pass {@link LaunchBridgeOptions} to the injected runtime. */
export const LAUNCH_OPTIONS_ENV = 'EAB_OPTIONS';

/** Most bytes of serialized launch options accepted (environment blocks are small on some platforms). */
export const MAX_LAUNCH_OPTIONS_BYTES = 8_192;

/**
 * The serializable part of the runtime's options that a launcher may set (Launch mode). Anything that
 * widens what clients may do (`eval`, packaged apps) has its own dedicated launcher variable instead.
 */
export const LaunchBridgeOptionsSchema = z
  .object({
    ipc: z
      .object({ values: z.array(z.string().min(1).max(256)).max(50).optional() })
      .strict()
      .optional(),
    logs: z
      .object({ mainConsole: z.boolean().optional(), sourceMaps: z.boolean().optional() })
      .strict()
      .optional(),
    snapshot: z.object({ clickListeners: z.boolean().optional() }).strict().optional(),
  })
  .strict();
export type LaunchBridgeOptions = z.infer<typeof LaunchBridgeOptionsSchema>;

/** Parse the launcher's options; throws with the offending field on bad input. */
export function parseLaunchOptions(raw: string): LaunchBridgeOptions {
  if (raw.length > MAX_LAUNCH_OPTIONS_BYTES) {
    throw new Error(`${LAUNCH_OPTIONS_ENV} is longer than ${MAX_LAUNCH_OPTIONS_BYTES} characters`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${LAUNCH_OPTIONS_ENV} is not valid JSON`);
  }
  const parsed = LaunchBridgeOptionsSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue !== undefined && issue.path.length > 0 ? issue.path.join('.') : 'options';
  throw new Error(`${LAUNCH_OPTIONS_ENV}: ${where}: ${issue?.message ?? 'invalid'}`);
}
