/**
 * Compile a simple glob into a predicate: `*` matches any run of characters (including none), `?`
 * exactly one code point, everything else is literal. Patterns come from agents and users and are
 * applied to whole ring buffers on the app's main thread, so matching must not be able to blow up:
 * this is the classic single-backtrack wildcard algorithm, O(pattern × text) worst case, unlike a
 * RegExp with many `.*` groups. Compile once, then call for each record.
 */
export function globMatcher(pattern: string): (text: string) => boolean {
  // Runs of `*` are equivalent to one.
  const tokens = Array.from(pattern.replace(/\*+/g, '*'));
  return (text) => matchTokens(tokens, Array.from(text));
}

/** One predicate for several globs (any match). An empty list matches nothing. */
export function anyGlobMatcher(patterns: readonly string[]): (text: string) => boolean {
  const matchers = patterns.map(globMatcher);
  return (text) => matchers.some((matches) => matches(text));
}

function matchTokens(pattern: readonly string[], text: readonly string[]): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    const token = pattern[p];
    if (token !== undefined && token !== '*' && (token === '?' || token === text[t])) {
      p++;
      t++;
    } else if (token === '*') {
      star = p++;
      resume = t;
    } else if (star !== -1) {
      // Let the last `*` absorb one more character and retry from there.
      p = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
