/**
 * A page of records: those after `since` up to and including `nextSeq`. `since` is where the read
 * really started (0 when the log reset a cursor from before it).
 */
export interface PageRange {
  readonly since: number;
  readonly nextSeq: number;
}

interface Gap {
  readonly key: string | undefined;
  /** The last record before the gap. */
  readonly after: number;
  count: number;
}

/** Gap entries kept; beyond that the oldest are folded into later ones (see `#fold`). */
const MAX_GAPS = 4_096;

/**
 * Records left out of a sequenced log on purpose (over a rate cap, malformed), remembered by where
 * they would have been. A gap belongs to the page that holds the record after it, so paging through a
 * log reports each gap exactly once, and only the gaps of the page (key) asked about. A gap at the very
 * end shows up once a record follows it (the console collector writes one before each query).
 */
export class Gaps {
  readonly #gaps: Gap[] = [];

  /** One record left out after record `after` (of `key`, e.g. a target id). */
  note(after: number, key?: string): void {
    const last = this.#gaps.at(-1);
    if (last?.after === after && last.key === key) {
      last.count++;
      return;
    }
    this.#gaps.push({ key, after, count: 1 });
    if (this.#gaps.length > MAX_GAPS) this.#fold();
  }

  /**
   * Make room without losing counts: a capped flood alternates recorded and left-out messages, so it
   * makes many small gaps. The oldest is added to the next gap of the same page (or the next one), so
   * only where its count shows up becomes approximate, never how many were left out.
   */
  #fold(): void {
    const oldest = this.#gaps.shift();
    if (oldest === undefined) return;
    const into = this.#gaps.find((gap) => gap.key === oldest.key) ?? this.#gaps[0];
    if (into !== undefined) into.count += oldest.count;
  }

  /** Records left out within `range` (and of `key`, when given). */
  within(range: PageRange, key?: string): number {
    let count = 0;
    for (const gap of this.#gaps) {
      if (key !== undefined && gap.key !== key) continue;
      // The record after the gap (after + 1) is in this page.
      if (gap.after >= range.since && gap.after < range.nextSeq) count += gap.count;
    }
    return count;
  }
}
