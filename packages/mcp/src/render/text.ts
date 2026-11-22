import { BridgeError, type Limitation } from '@eab/core';

/** Opening and closing lines of an untrusted block (look-alikes inside a block are defanged). */
export const UNTRUSTED_OPEN = '<untrusted-page-content>';
export const UNTRUSTED_CLOSE = '</untrusted-page-content>';
const OPEN = UNTRUSTED_OPEN;
const CLOSE = UNTRUSTED_CLOSE;
/** Any spelling of either delimiter tag: case, whitespace and an optional slash vary. */
const DELIMITER = /<\s*\/?\s*untrusted-page-content\b[^>]*>/gi;

/**
 * Delimit page-authored text (content, titles, URLs) so agents treat it as data, never as instructions.
 * A page cannot open or close the block itself: delimiter look-alikes inside are defanged.
 */
export function untrusted(text: string): string {
  const safe = text.replace(DELIMITER, (tag) => tag.replaceAll('<', '‹').replaceAll('>', '›'));
  return `${OPEN}\n${safe}\n${CLOSE}`;
}

/** Render `limitations[]`; empty string when there are none. */
export function renderLimitations(limitations: readonly Limitation[]): string {
  if (limitations.length === 0) return '';
  return `\n\nLimitations:\n${limitations.map((l) => `- ${l.code}: ${l.message}`).join('\n')}`;
}

/** Render any failure as `Error [CODE]: message` plus the hint, if any. */
export function renderError(error: unknown): string {
  const bridgeError = BridgeError.from(error);
  const hint = bridgeError.hint === undefined ? '' : `\nHint: ${bridgeError.hint}`;
  return `Error [${bridgeError.code}]: ${bridgeError.message}${hint}`;
}
