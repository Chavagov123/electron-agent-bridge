/** A `sendSync` a page is blocked on: the main process has not set its return value yet. */
export interface SyncWait {
  readonly channel: string;
  /** When the main process received it (ms since epoch). */
  readonly since: number;
  /** Pages (windows, dialogs) opened before it began: see {@link SyncWaits.openedDuring}. */
  readonly openedBefore: number;
}

/** Ends one wait; calling it again does nothing. */
export type EndWait = () => void;

/**
 * The `sendSync` messages each page is waiting on. A renderer runs nothing (no script, no input, no
 * debugger command) until its `sendSync` is answered, so a page with an old wait is blocked: usually
 * on a dialog the main process shows before replying. Keyed by target id (`wc<n>`).
 */
export class SyncWaits {
  readonly #byPage = new Map<string, Set<SyncWait>>();
  readonly #now: () => number;
  #opened = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  begin(page: string, channel: string): EndWait {
    const wait: SyncWait = { channel, since: this.#now(), openedBefore: this.#opened };
    let waits = this.#byPage.get(page);
    if (!waits) {
      waits = new Set();
      this.#byPage.set(page, waits);
    }
    waits.add(wait);
    return () => {
      const current = this.#byPage.get(page);
      if (!current?.delete(wait)) return;
      if (current.size === 0) this.#byPage.delete(page);
    };
  }

  /** A page (a window, often the dialog a waiting page is blocked on) was opened. */
  noteOpened(): void {
    this.#opened++;
  }

  /** Whether a page was opened while `wait` was pending (the app showed a window: likely its dialog). */
  openedDuring(wait: SyncWait): boolean {
    return this.#opened > wait.openedBefore;
  }

  /** Some page waits on a `sendSync` now. */
  get pending(): boolean {
    return this.#byPage.size > 0;
  }

  /** The page's longest-running wait, if it has one. */
  oldest(page: string): SyncWait | undefined {
    const waits = this.#byPage.get(page);
    // A Set iterates in insertion order: the first wait is the oldest.
    return waits?.values().next().value;
  }

  /**
   * The page's waits are over: it is gone (destroyed, renderer crashed), or it answers, so they were
   * answered in a way the wrappers could not see.
   */
  clear(page: string): void {
    this.#byPage.delete(page);
  }
}
