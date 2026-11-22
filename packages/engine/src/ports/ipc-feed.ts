/** One IPC message as actions and waits need it (the full record stays with `ipc.query`). */
export interface IpcFeedItem {
  readonly seq: number;
  readonly channel: string;
  readonly kind: string;
}

/**
 * The app's IPC as seen by the runtime (implemented next to the IPC hooks in the main process). Lets
 * an action report the IPC it caused and a wait wait for a message, without the engine knowing Electron.
 */
export interface IpcFeed {
  /** The last sequence number so far. */
  lastSeq(): number;
  /** App messages (not Electron's internal ones) after `seq`, oldest first, and where to continue. */
  since(seq: number, limit: number): IpcFeedPage;
}

/** One read of the feed. `nextSeq` also skips internal messages, so a wait never rereads them. */
export interface IpcFeedPage {
  readonly items: readonly IpcFeedItem[];
  readonly nextSeq: number;
}
