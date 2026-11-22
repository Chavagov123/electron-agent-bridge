import { BridgeError, LIMITATION_CODES } from '@eab/core';

import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../render/text.js';
import type { SpillSink } from './spill.js';

/** Output longer than this (~8k tokens) is written to a file; the reply keeps the head and the path. */
export const SPILL_CHARS = 32_000;
/** How much of a spilled output stays inline. */
export const HEAD_CHARS = 4_000;

const LIMITATIONS_HEADER = '\n\nLimitations:\n';

/**
 * Fit tool output into a reply. Oversized output goes to a file; the reply keeps whole lines of the
 * head (closing an untrusted block the cut left open, so page text never runs into our notes) and the
 * output's own limitations. If the file cannot be written, the head is still returned, with the reason.
 */
export function fitOutput(text: string, spill: SpillSink): string {
  if (text.length <= SPILL_CHARS) return text;
  const { body, limitations } = splitLimitations(text);
  let where: string;
  try {
    where = `all of it is in ${spill.write(text)}`;
  } catch (error) {
    where = `the rest could not be saved (${BridgeError.from(error).message})`;
  }
  const note = `- ${LIMITATION_CODES.spilled}: the output was ${text.length} characters; the first part is shown and ${where}`;
  return `${head(body)}\n… (cut here)${LIMITATIONS_HEADER}${[...limitations, note].join('\n')}`;
}

/** The trailing `Limitations:` section, if it comes after every untrusted block (so it is ours). */
function splitLimitations(text: string): { body: string; limitations: string[] } {
  const at = text.lastIndexOf(LIMITATIONS_HEADER);
  if (at === -1 || at < text.lastIndexOf(UNTRUSTED_CLOSE)) return { body: text, limitations: [] };
  return { body: text.slice(0, at), limitations: text.slice(at + LIMITATIONS_HEADER.length).split('\n') };
}

function head(body: string): string {
  const cut = body.lastIndexOf('\n', HEAD_CHARS);
  const kept = body.slice(0, cut > 0 ? cut : HEAD_CHARS);
  // Delimiters always stand on their own lines; look-alikes inside a block are defanged.
  const lines = kept.split('\n');
  const open = lines.filter((line) => line === UNTRUSTED_OPEN).length;
  const closed = lines.filter((line) => line === UNTRUSTED_CLOSE).length;
  return open > closed ? `${kept}\n${UNTRUSTED_CLOSE}` : kept;
}
