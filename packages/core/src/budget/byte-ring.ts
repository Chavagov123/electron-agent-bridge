import { jsonByteSize } from '../util/utf8.js';

export interface ByteRingOptions<T> {
  /** Total bytes retained; the oldest entries are evicted to make room. */
  readonly capacityBytes: number;
  /**
   * Size of one item; defaults to the UTF-8 size of its JSON. If it throws or returns a negative or
   * non-finite number, the JSON size is used instead, so a buggy estimator cannot break the bound.
   */
  readonly sizeOf?: (item: T) => number;
}

/** A stored item with its sequence number (1-based, strictly increasing, never reused). */
export interface RingEntry<T> {
  readonly seq: number;
  readonly item: T;
}

/** One page of a read. */
export interface RingPage<T> {
  readonly entries: readonly RingEntry<T>[];
  /** Pass as `since` to continue after this page. */
  readonly nextSeq: number;
  /** Entries newer than `since` that were evicted before this read: the caller missed them. */
  readonly dropped: number;
  /** More retained entries follow this page. */
  readonly more: boolean;
  /**
   * The cursor was ahead of this buffer (e.g. it came from a previous app run): reading restarted
   * from the beginning and everything before the oldest retained entry counts as dropped.
   */
  readonly cursorReset: boolean;
}

export interface RingStats {
  readonly entries: number;
  readonly bytes: number;
  readonly capacityBytes: number;
  /** Entries evicted to make room since creation (or the last clear). */
  readonly evicted: number;
  /** Items refused because a single item exceeded the whole capacity. They get no sequence number. */
  readonly rejected: number;
  readonly lastSeq: number;
}

interface Slot<T> extends RingEntry<T> {
  readonly bytes: number;
}

/**
 * FIFO buffer bounded by bytes, not count (NFR3): pushing never fails, old data is evicted, and
 * every reader learns how much it missed. O(1) amortised push; reads are O(log n + page size).
 */
export class ByteRing<T> {
  readonly #capacity: number;
  readonly #sizeOf: (item: T) => number;
  /** Live slots are `#slots[#head..]`; evicted positions are cleared so their items can be collected. */
  #slots: (Slot<T> | undefined)[] = [];
  #head = 0;
  #bytes = 0;
  #lastSeq = 0;
  #evicted = 0;
  #rejected = 0;

  constructor(options: ByteRingOptions<T>) {
    if (!(options.capacityBytes > 0)) throw new RangeError('capacityBytes must be positive');
    this.#capacity = options.capacityBytes;
    this.#sizeOf = options.sizeOf ?? jsonByteSize;
  }

  /** Store an item; returns its sequence number, or `undefined` if it alone exceeds the capacity. */
  push(item: T): number | undefined {
    const bytes = this.#measure(item);
    if (bytes > this.#capacity) {
      this.#rejected++;
      return undefined;
    }
    while (this.#bytes + bytes > this.#capacity) this.#evictOldest();
    const seq = ++this.#lastSeq;
    this.#slots.push({ seq, item, bytes });
    this.#bytes += bytes;
    return seq;
  }

  /** Entries with `seq > since`, oldest first, at most `limit`. */
  read(since = 0, limit = Number.POSITIVE_INFINITY): RingPage<T> {
    const cursorReset = since > this.#lastSeq;
    const from = cursorReset ? 0 : Math.max(0, since);
    const start = this.#firstIndexAfter(from);
    const end = Math.min(this.#slots.length, start + Math.max(0, Math.floor(limit)));
    const entries: RingEntry<T>[] = [];
    for (let index = start; index < end; index++) {
      const slot = this.#slots[index];
      if (slot) entries.push({ seq: slot.seq, item: slot.item });
    }
    const oldest = this.#slots[this.#head]?.seq ?? this.#lastSeq + 1;
    return {
      entries,
      nextSeq: entries.at(-1)?.seq ?? Math.max(from, oldest - 1),
      dropped: Math.max(0, oldest - 1 - from),
      more: end < this.#slots.length,
      cursorReset,
    };
  }

  /**
   * Up to `limit` entries with `seq > since` that pass `keep`, oldest first. The cursor (`nextSeq`)
   * also advances over entries `keep` rejects, so paging with a filter never revisits them.
   */
  readMatching(since: number, limit: number, keep: (item: T) => boolean): RingPage<T> {
    const cursorReset = since > this.#lastSeq;
    const from = cursorReset ? 0 : Math.max(0, since);
    const oldest = this.#slots[this.#head]?.seq ?? this.#lastSeq + 1;
    const entries: RingEntry<T>[] = [];
    let nextSeq = Math.max(from, oldest - 1);
    let index = this.#firstIndexAfter(from);
    for (; index < this.#slots.length && entries.length < limit; index++) {
      const slot = this.#slots[index];
      if (!slot) continue;
      nextSeq = slot.seq;
      if (keep(slot.item)) entries.push({ seq: slot.seq, item: slot.item });
    }
    return {
      entries,
      nextSeq,
      dropped: Math.max(0, oldest - 1 - from),
      more: index < this.#slots.length,
      cursorReset,
    };
  }

  get stats(): RingStats {
    return {
      entries: this.#slots.length - this.#head,
      bytes: this.#bytes,
      capacityBytes: this.#capacity,
      evicted: this.#evicted,
      rejected: this.#rejected,
      lastSeq: this.#lastSeq,
    };
  }

  /** Forget all entries and counters except the sequence (so old cursors stay meaningful). */
  clear(): void {
    this.#slots = [];
    this.#head = 0;
    this.#bytes = 0;
    this.#evicted = 0;
    this.#rejected = 0;
  }

  #measure(item: T): number {
    let bytes: number;
    try {
      bytes = this.#sizeOf(item);
    } catch {
      bytes = Number.NaN;
    }
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : jsonByteSize(item);
  }

  #evictOldest(): void {
    const slot = this.#slots[this.#head];
    if (!slot) return;
    this.#slots[this.#head] = undefined;
    this.#head++;
    this.#bytes -= slot.bytes;
    this.#evicted++;
    // Compact once the dead prefix dominates, keeping push amortised O(1).
    if (this.#head > 1024 && this.#head * 2 > this.#slots.length) {
      this.#slots = this.#slots.slice(this.#head);
      this.#head = 0;
    }
  }

  /** Binary search for the first live slot with `seq > since` (seqs are strictly increasing). */
  #firstIndexAfter(since: number): number {
    let low = this.#head;
    let high = this.#slots.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.#slots[middle]?.seq ?? Number.POSITIVE_INFINITY) <= since) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}
