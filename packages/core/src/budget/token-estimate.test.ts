import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { estimateTokens, fitToTokens } from './token-estimate.js';

describe('estimateTokens', () => {
  it('counts ~4 ASCII characters per token and one per non-ASCII code point', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('日本語')).toBe(3);
    expect(estimateTokens('😀')).toBe(1);
  });

  it('property: monotonic under concatenation', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(estimateTokens(a + b)).toBeGreaterThanOrEqual(Math.max(estimateTokens(a), estimateTokens(b)));
      }),
    );
  });
});

describe('fitToTokens', () => {
  it('returns the input untouched when it fits', () => {
    expect(fitToTokens('a\nb', 10)).toEqual({
      text: 'a\nb',
      truncated: false,
      totalTokens: 1,
      omittedLines: 0,
    });
  });

  it('keeps whole leading lines and reports how many were left out', () => {
    const text = ['aaaa', 'bbbb', 'cccc', 'dddd'].join('\n');
    const fitted = fitToTokens(text, 4);
    expect(fitted.text).toBe('aaaa\nbbbb');
    expect(fitted).toMatchObject({ truncated: true, omittedLines: 2 });
  });

  it('keeps a first line that fits the budget exactly (no newline is charged for it)', () => {
    const fitted = fitToTokens(`abcdefgh\n${'x'.repeat(400)}`, 2);
    expect(fitted.text).toBe('abcdefgh');
    expect(fitted.omittedLines).toBe(1);
  });

  it('cuts a single oversized line by characters with an ellipsis', () => {
    const fitted = fitToTokens('x'.repeat(100), 5);
    expect(fitted.text).toBe(`${'x'.repeat(16)}…`);
    expect(fitted.omittedLines).toBe(0);
    expect(fitToTokens('x'.repeat(100), 0).text).toBe('');
  });

  it('property: output never exceeds the budget and is a prefix of the input', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 400 }),
        fc.integer({ min: 0, max: 60 }),
        (text, budget) => {
          const fitted = fitToTokens(text, budget);
          expect(estimateTokens(fitted.text)).toBeLessThanOrEqual(Math.max(budget, 0));
          const kept = fitted.text.endsWith('…') && fitted.truncated ? fitted.text.slice(0, -1) : fitted.text;
          expect(text.startsWith(kept)).toBe(true);
          expect(fitted.truncated).toBe(estimateTokens(text) > budget);
        },
      ),
    );
  });
});
