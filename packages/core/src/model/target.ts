import { z } from 'zod';

/** What kind of Electron surface a target is. */
/** `worker` and `serviceWorker` (protocol 1.1) have logs and network only, no page. */
export const TargetKindSchema = z.enum([
  'window',
  'view',
  'webview',
  'other',
  'worker',
  'serviceWorker',
  'offscreen',
]);
export type TargetKind = z.infer<typeof TargetKindSchema>;

/** Why the bridge is not attached to a target. */
export const DetachReasonSchema = z.enum(['host-debugger', 'target-closed', 'crashed', 'closed', 'unknown']);
export type DetachReason = z.infer<typeof DetachReasonSchema>;

/** A controllable page (one webContents). */
export const TargetInfoSchema = z.object({
  /** Stable for the life of the webContents. */
  id: z.string(),
  /**
   * Human-friendly, unique among live targets and stable once assigned: the app's explicit name,
   * else the page's file name, else its title, else its kind plus a counter. Usable wherever an id is.
   */
  name: z.string(),
  kind: TargetKindSchema,
  title: z.string(),
  url: z.string(),
  /** False when the bridge is not attached; see `detachedReason`. */
  attached: z.boolean(),
  detachedReason: DetachReasonSchema.optional(),
  /** On screen (its window shown, its view visible and sized); absent when the runtime cannot tell. */
  visible: z.boolean().optional(),
});
export type TargetInfo = z.infer<typeof TargetInfoSchema>;
