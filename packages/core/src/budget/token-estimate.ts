/**
 * Conservative, tokenizer-free token estimate: about 4 ASCII characters per token, and one token per
 * non-ASCII code point (CJK, emoji and accented text tokenize far worse than English). Deterministic and
 * monotonic, so it is safe for budgeting; it over-estimates rather than under-estimates.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) < 0x80) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

/** Result of {@link fitToTokens}. */
export interface FittedText {
  readonly text: string;
  readonly truncated: boolean;
  /** Estimated tokens of the whole input. */
  readonly totalTokens: number;
  /** Lines of the input that were left out. */
  readonly omittedLines: number;
}

/**
 * Keep whole lines from the start of `text` while the estimate stays within `maxTokens`.
 * If even the first line is too large, it is cut by characters and marked with an ellipsis.
 */
export function fitToTokens(text: string, maxTokens: number): FittedText {
  const totalTokens = estimateTokens(text);
  if (totalTokens <= maxTokens) return { text, truncated: false, totalTokens, omittedLines: 0 };
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    // Only lines after the first pay for the newline that joins them.
    const cost = estimateTokens(line) + (kept.length > 0 ? 1 : 0);
    if (used + cost > maxTokens) break;
    kept.push(line);
    used += cost;
  }
  if (kept.length === 0) {
    return {
      text: clipToTokens(lines[0] ?? '', maxTokens),
      truncated: true,
      totalTokens,
      omittedLines: lines.length - 1,
    };
  }
  return { text: kept.join('\n'), truncated: true, totalTokens, omittedLines: lines.length - kept.length };
}

/** Cut one line to fit, counting incrementally (linear); the trailing ellipsis costs one token. */
function clipToTokens(line: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  const budget = maxTokens - 1;
  let ascii = 0;
  let other = 0;
  let clipped = '';
  for (const char of line) {
    const isAscii = (char.codePointAt(0) ?? 0) < 0x80;
    const cost = Math.ceil((ascii + (isAscii ? 1 : 0)) / 4) + other + (isAscii ? 0 : 1);
    if (cost > budget) break;
    if (isAscii) ascii++;
    else other++;
    clipped += char;
  }
  return `${clipped}…`;
}
