import { describe, expect, it } from 'vitest';

import { Gaps } from './gaps.js';

describe('Gaps', () => {
  it('counts a gap in the page holding the record after it, once, and only of the asked key', () => {
    const gaps = new Gaps();
    gaps.note(3, 'wc1');
    gaps.note(3, 'wc1');
    gaps.note(7, 'wc2');
    gaps.note(10, 'wc1');
    // Records 1-5: the two between 3 and 4.
    expect(gaps.within({ since: 0, nextSeq: 5 })).toBe(2);
    // Records 6-10: the gap after 7 (the one after 10 waits for record 11).
    expect(gaps.within({ since: 5, nextSeq: 10 })).toBe(1);
    // Records 11-12: the gap after 10.
    expect(gaps.within({ since: 10, nextSeq: 12 })).toBe(1);
    expect(gaps.within({ since: 0, nextSeq: 12 }, 'wc1')).toBe(3);
    // Paging the whole log in any page size counts every gap exactly once.
    for (const size of [1, 2, 3, 4, 5, 12]) {
      let total = 0;
      for (let since = 0; since < 12; since += size) total += gaps.within({ since, nextSeq: since + size });
      expect(total).toBe(4);
    }
    // Polling again from the end reports nothing new.
    expect(gaps.within({ since: 12, nextSeq: 12 })).toBe(0);
  });

  it('stays bounded without losing counts (a capped flood makes many small gaps)', () => {
    const gaps = new Gaps();
    for (let seq = 0; seq < 10_000; seq++) gaps.note(seq, seq % 2 === 0 ? 'wc1' : 'wc2');
    expect(gaps.within({ since: 0, nextSeq: 10_001 })).toBe(10_000);
    expect(gaps.within({ since: 0, nextSeq: 10_001 }, 'wc1')).toBe(5_000);
  });
});
