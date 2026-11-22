import { z } from 'zod';

/** One IPC message or handler call (FR5). Values only for opted-in channels, always redacted. */
export const IpcEventSchema = z.object({
  seq: z.number().int(),
  ts: z.number(),
  /** Correlation id shared by a request and its response. */
  corr: z.string(),
  correlation: z.enum(['exact', 'heuristic']),
  channel: z.string(),
  /**
   * Since protocol 1.1: `utilityMessage` (main ↔ a utilityProcess child), `portMessage` (a MessagePortMain)
   * and `bridgeCall` (a function the preload exposed through contextBridge, called by the page).
   */
  kind: z.enum([
    'send',
    'sendSync',
    'invoke',
    'handle',
    'on',
    'toRenderer',
    'postMessage',
    'utilityMessage',
    'portMessage',
    'bridgeCall',
  ]),
  phase: z.enum(['request', 'response', 'error']),
  side: z.enum(['main', 'renderer', 'utility']),
  /** Since protocol 1.1, for utility and port messages: sent from main (`out`) or received by it (`in`). */
  direction: z.enum(['out', 'in']).optional(),
  /** `low` when the record came from a renderer without context isolation (spoofable). */
  trust: z.enum(['high', 'low']),
  /** Registered by Electron or a library before the app's own code ran. */
  internal: z.boolean().optional(),
  sender: z.object({ target: z.string(), frameId: z.number().int().optional() }).optional(),
  argShape: z.string(),
  values: z.unknown().optional(),
  durMs: z.number().optional(),
});
export type IpcEvent = z.infer<typeof IpcEventSchema>;

/** One console message, exception, crash or process event (FR7). */
export const LogEntrySchema = z.object({
  seq: z.number().int(),
  ts: z.number(),
  source: z.enum(['renderer', 'main', 'process', 'custom']),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  text: z.string(),
  target: z.string().optional(),
  url: z.string().optional(),
  line: z.number().int().optional(),
  /** Since protocol 1.1: the 1-based column of `line` (a minified bundle needs it to be mapped). */
  column: z.number().int().optional(),
  stack: z.string().optional(),
  /** Since protocol 1.1: `url`, `line` and stack frames were mapped to original sources. */
  mapped: z.boolean().optional(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

/** Metadata of one network request (FR8). Bodies are never buffered. */
export const NetworkRecordSchema = z.object({
  seq: z.number().int(),
  ts: z.number(),
  /** The page's target id (shown by name), or `main` for requests of the main process (protocol 1.1). */
  target: z.string(),
  requestId: z.string(),
  method: z.string(),
  url: z.string(),
  resourceType: z.string().optional(),
  status: z.number().int().optional(),
  mimeType: z.string().optional(),
  /** Set when the request failed (net error text or `blocked`). */
  failed: z.string().optional(),
  durMs: z.number().optional(),
  encodedBytes: z.number().int().optional(),
  fromCache: z.boolean().optional(),
  /** Since protocol 1.1: the response came from the page's service worker. */
  fromServiceWorker: z.boolean().optional(),
});
export type NetworkRecord = z.infer<typeof NetworkRecordSchema>;

/** Common paging params for ring-buffer queries. */
export const PageParamsShape = {
  /** Return records with `seq > since` (use the previous `nextSeq`). */
  since: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
};

/** Common paging fields of ring-buffer query results. */
export function pageDataSchema<T extends z.ZodType>(
  item: T,
): z.ZodObject<{ items: z.ZodArray<T>; nextSeq: z.ZodNumber; dropped: z.ZodNumber; more: z.ZodBoolean }> {
  return z.object({
    items: z.array(item),
    nextSeq: z.number().int(),
    dropped: z.number().int(),
    more: z.boolean(),
  });
}
