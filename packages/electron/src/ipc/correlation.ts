/** Correlation ids waiting per key (above the preload's batch size); beyond these bounds pairing stops. */
const MAX_PER_KEY = 512;
const MAX_KEYS = 1_000;

/**
 * Main-side request ids, first in, first out per (page, frame, channel), waiting for the renderer's
 * record of the same message (which arrives later through the uplink). IPC from one frame keeps its
 * order per channel (ADR-0003), so the k-th renderer request is the k-th main-side one.
 */
export class CorrelationQueue {
  readonly #queues = new Map<string, string[]>();

  push(key: string, corr: string): void {
    let queue = this.#queues.get(key);
    if (!queue) {
      if (this.#queues.size >= MAX_KEYS) this.#queues.delete(this.#queues.keys().next().value ?? key);
      queue = [];
      this.#queues.set(key, queue);
    }
    queue.push(corr);
    // Overflow means the renderer's records fell behind: forget the key rather than pair wrongly.
    if (queue.length > MAX_PER_KEY) this.#queues.delete(key);
  }

  /** Forget every waiting id whose key starts with `prefix` (a frame whose renderer dropped records). */
  clearPrefix(prefix: string): void {
    for (const key of [...this.#queues.keys()]) if (key.startsWith(prefix)) this.#queues.delete(key);
  }

  /** The oldest waiting id for this key, if any. */
  take(key: string): string | undefined {
    const queue = this.#queues.get(key);
    const corr = queue?.shift();
    if (queue?.length === 0) this.#queues.delete(key);
    return corr;
  }
}
