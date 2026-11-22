import type { Limitation } from './envelope.js';

/**
 * Well-known limitation codes. Agents may branch on these; free-form codes are allowed for
 * one-off cases but should be added here once they recur.
 */
export const LIMITATION_CODES = {
  /** Output was cut to fit a budget. */
  truncated: 'truncated',
  /** Buffered events were evicted before they were read. */
  dropped: 'dropped',
  /** Some values were replaced because they looked secret. */
  redacted: 'redacted',
  /** Output was written to a file instead of returned inline. */
  spilled: 'spilled',
  /** The result covers only part of what was asked (e.g. some frames unreachable). */
  partial: 'partial',
  /** A best-effort method was used (e.g. heuristic IPC correlation). */
  approximate: 'approximate',
  /** A delta was asked for but a full snapshot was returned (the reason says why). */
  fullSnapshot: 'full-snapshot',
  /** The feature is unavailable in this connection mode (e.g. main-process data when attached to renderers only). */
  degraded: 'degraded',
} as const;

/** Output cut to fit a budget. */
export function truncatedLimitation(what: string, kept: number, total: number, unit: string): Limitation {
  return { code: LIMITATION_CODES.truncated, message: `${what}: kept ${kept} of ${total} ${unit}.` };
}

/** Buffered items evicted before the caller read them. `undefined` when nothing was dropped. */
export function droppedLimitation(what: string, count: number): Limitation | undefined {
  if (count <= 0) return undefined;
  return {
    code: LIMITATION_CODES.dropped,
    message: `${count} ${what} were evicted before this read; query more often or narrow the filter.`,
  };
}

/** Values withheld because their keys looked secret. `undefined` when nothing was redacted. */
export function redactedLimitation(count: number): Limitation | undefined {
  if (count <= 0) return undefined;
  return {
    code: LIMITATION_CODES.redacted,
    message: `${count} value(s) with secret-looking keys were redacted.`,
  };
}

/** Drop the `undefined` entries produced by the conditional helpers above. */
export function compactLimitations(limitations: readonly (Limitation | undefined)[]): Limitation[] {
  return limitations.filter((limitation): limitation is Limitation => limitation !== undefined);
}
