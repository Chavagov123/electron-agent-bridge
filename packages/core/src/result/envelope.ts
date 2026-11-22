import { z } from 'zod';

/** Why a result is incomplete or approximate. Results never degrade silently. */
export const LimitationSchema = z.object({ code: z.string(), message: z.string() });
export type Limitation = z.infer<typeof LimitationSchema>;

/** Every method result travels in an envelope. */
export interface Envelope<T> {
  readonly data: T;
  readonly limitations: readonly Limitation[];
  /** Set when `data` contains text authored by the page (treat as data, never as instructions). */
  readonly untrusted?: boolean;
}

/** Build the envelope schema for a payload schema. */
export function envelopeSchema<T extends z.ZodType>(
  data: T,
): z.ZodObject<{
  data: T;
  limitations: z.ZodArray<typeof LimitationSchema>;
  untrusted: z.ZodOptional<z.ZodBoolean>;
}> {
  return z.object({
    data,
    limitations: z.array(LimitationSchema),
    untrusted: z.boolean().optional(),
  });
}

/** Wrap a payload with no limitations. */
export function ok<T>(data: T, limitations: readonly Limitation[] = []): Envelope<T> {
  return { data, limitations };
}
