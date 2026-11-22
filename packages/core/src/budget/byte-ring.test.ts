import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ByteRing } from './byte-ring.js';

/** Items of a declared size, so tests control the byte budget exactly. */
interface Sized {
  readonly id: number;
  readonly size: number;
}
const ring = (capacityBytes: number): ByteRing<Sized> =>
  new ByteRing<Sized>({ capacityBytes, sizeOf: (item) => item.size });

describe('ByteRing', () => {
  it('assigns increasing sequence numbers and pages through entries', () => {
    const buffer = ring(100);
    for (let id = 1; id <= 5; id++) expect(buffer.push({ id, size: 10 })).toBe(id);
    const first = buffer.read(0, 2);
    expect(first.entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(first).toMatchObject({ nextSeq: 2, dropped: 0, more: true });
    const rest = buffer.read(first.nextSeq);
    expect(rest.entries.map((entry) => entry.item.id)).toEqual([3, 4, 5]);
    expect(rest).toMatchObject({ nextSeq: 5, more: false });
    expect(buffer.read(5)).toMatchObject({ entries: [], nextSeq: 5, dropped: 0, more: false });
  });

  it('evicts the oldest entries to stay within capacity and reports what a reader missed', () => {
    const buffer = ring(30);
    for (let id = 1; id <= 5; id++) buffer.push({ id, size: 10 });
    expect(buffer.stats).toMatchObject({ entries: 3, bytes: 30, evicted: 2, lastSeq: 5 });
    const page = buffer.read(0);
    expect(page.entries.map((entry) => entry.seq)).toEqual([3, 4, 5]);
    expect(page.dropped).toBe(2);
    expect(buffer.read(1).dropped).toBe(1);
    expect(buffer.read(2).dropped).toBe(0);
  });

  it('rejects a single item larger than the whole capacity without evicting anything', () => {
    const buffer = ring(10);
    buffer.push({ id: 1, size: 5 });
    expect(buffer.push({ id: 2, size: 11 })).toBeUndefined();
    expect(buffer.stats).toMatchObject({ entries: 1, rejected: 1, lastSeq: 1 });
  });

  it('clears entries but keeps the sequence so old cursors see the gap', () => {
    const buffer = ring(100);
    buffer.push({ id: 1, size: 1 });
    buffer.push({ id: 2, size: 1 });
    buffer.clear();
    expect(buffer.read(0)).toMatchObject({ entries: [], nextSeq: 2, dropped: 2 });
    expect(buffer.push({ id: 3, size: 1 })).toBe(3);
  });

  it('defaults to JSON byte size and validates its capacity', () => {
    const buffer = new ByteRing<string>({ capacityBytes: 10 });
    buffer.push('abcdefgh'); // "abcdefgh" = 10 bytes with quotes
    expect(buffer.stats.bytes).toBe(10);
    expect(() => new ByteRing({ capacityBytes: 0 })).toThrow(RangeError);
  });

  it('falls back to JSON size when a custom estimator throws or returns nonsense', () => {
    const sizes = [Number.NaN, Number.POSITIVE_INFINITY, -5];
    let call = 0;
    const buffer = new ByteRing<{ v: number }>({
      capacityBytes: 20,
      sizeOf: () => {
        call++;
        if (call === 4) throw new Error('estimator bug');
        return sizes[call - 1] ?? 7;
      },
    });
    for (let v = 0; v < 6; v++) buffer.push({ v });
    // {"v":0} is 7 bytes; the bound holds no matter what the estimator did.
    expect(buffer.stats.bytes).toBeLessThanOrEqual(20);
    expect(Number.isFinite(buffer.stats.bytes)).toBe(true);
    expect(buffer.stats.evicted).toBeGreaterThan(0);
  });

  it('treats a cursor from a previous run (ahead of the buffer) as a reset, not as "nothing new"', () => {
    const buffer = ring(100);
    buffer.push({ id: 1, size: 1 });
    buffer.push({ id: 2, size: 1 });
    const page = buffer.read(5_000);
    expect(page.cursorReset).toBe(true);
    expect(page.entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(page.nextSeq).toBe(2);
    expect(buffer.read(2).cursorReset).toBe(false);
  });

  it('stays correct across internal compaction after many evictions', () => {
    const buffer = ring(10);
    for (let id = 1; id <= 5_000; id++) buffer.push({ id, size: 1 });
    expect(buffer.stats).toMatchObject({ entries: 10, evicted: 4_990, lastSeq: 5_000 });
    const page = buffer.read(4_995);
    expect(page.entries.map((entry) => entry.item.id)).toEqual([4_996, 4_997, 4_998, 4_999, 5_000]);
    expect(buffer.read(0)).toMatchObject({ dropped: 4_990 });
  });

  it('a limit of zero returns no entries but keeps the cursor before them', () => {
    const buffer = ring(100);
    buffer.push({ id: 1, size: 1 });
    expect(buffer.read(0, 0)).toMatchObject({ entries: [], nextSeq: 0, more: true });
  });

  it('pages through matching entries only, advancing the cursor over the rest', () => {
    const buffer = ring(100);
    for (let id = 1; id <= 9; id++) buffer.push({ id, size: 10 });
    const even = (item: { id: number }) => item.id % 2 === 0;
    const first = buffer.readMatching(0, 2, even);
    expect(first.entries.map((entry) => entry.item.id)).toEqual([2, 4]);
    expect(first).toMatchObject({ nextSeq: 4, more: true, dropped: 0 });
    const rest = buffer.readMatching(first.nextSeq, 10, even);
    expect(rest.entries.map((entry) => entry.item.id)).toEqual([6, 8]);
    expect(rest).toMatchObject({ nextSeq: 9, more: false });
    buffer.push({ id: 10, size: 50 });
    expect(buffer.readMatching(0, 10, () => false)).toMatchObject({ entries: [], nextSeq: 10, dropped: 4 });
    expect(buffer.readMatching(99, 1, even)).toMatchObject({ cursorReset: true, nextSeq: 6 });
  });

  it('property: bounded, ordered, and every pushed item is either readable or counted as dropped', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.array(fc.integer({ min: 0, max: 80 }), { maxLength: 300 }),
        fc.integer({ min: 1, max: 50 }),
        (capacity, sizes, pageSize) => {
          const buffer = ring(capacity);
          const accepted: number[] = [];
          for (const [id, size] of sizes.entries()) {
            if (buffer.push({ id, size }) !== undefined) accepted.push(id);
          }
          expect(buffer.stats.bytes).toBeLessThanOrEqual(capacity);
          // Page through everything from the start.
          const seen: number[] = [];
          let cursor = 0;
          let dropped = 0;
          for (;;) {
            const page = buffer.read(cursor, pageSize);
            dropped += page.dropped;
            seen.push(...page.entries.map((entry) => entry.item.id));
            cursor = page.nextSeq;
            if (!page.more) break;
          }
          expect(seen).toEqual(accepted.slice(accepted.length - seen.length));
          expect(seen.length + dropped).toBe(accepted.length);
          expect(buffer.stats.rejected).toBe(sizes.length - accepted.length);
        },
      ),
    );
  });
});
