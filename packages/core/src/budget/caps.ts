const KB = 1024;
const MB = 1024 * KB;

/**
 * Default budgets (NFR3). Every buffer and output in the bridge is bounded by one of these and
 * counts what it drops; apps may lower them, never remove them.
 */
export const CAPS = {
  /** IPC event ring (metadata + shapes; values only for opted-in channels). */
  ipcRingBytes: 2 * MB,
  /** Console / crash / process log ring. */
  logRingBytes: 1 * MB,
  /** Network request metadata ring (bodies are never buffered). */
  networkRingBytes: 2 * MB,
  /** Results larger than this many estimated tokens are spilled to a file instead of returned inline. */
  inlineTokens: 8_000,
  /** Lines in one snapshot before it is truncated (with a limitation). */
  snapshotLines: 2_000,
  /** Items returned by one query page. */
  pageItems: 100,
  /** Hard ceiling for one query page. */
  maxPageItems: 500,
  /** Serialisation limits for captured values (IPC args, state, eval results). */
  value: { maxDepth: 6, maxKeys: 50, maxArrayItems: 50, maxStringChars: 1_000, maxNodes: 5_000 },
} as const;
