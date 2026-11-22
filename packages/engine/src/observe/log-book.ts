import { ByteRing, CAPS, type LogEntry } from '@eab/core';

import { safeUrl } from './url-privacy.js';

/** Longest text and stack kept per entry; a runaway log line must not evict the whole ring. */
export const MAX_LOG_TEXT = 4_000;
export const MAX_LOG_STACK = 4_000;

const LEVELS: readonly LogEntry['level'][] = ['debug', 'info', 'warn', 'error'];

/** An entry as a source reports it; the book assigns `seq` (and `ts` when missing). */
export type NewLogEntry = Omit<LogEntry, 'seq' | 'ts'> & { readonly ts?: number };

export interface LogQuery {
  readonly since?: number;
  readonly limit?: number;
  readonly source?: LogEntry['source'];
  readonly minLevel?: LogEntry['level'];
  /** Only entries of this page (target id). */
  readonly targetId?: string;
  /** Case-insensitive substring of the text or URL. */
  readonly contains?: string;
}

export interface LogPage {
  readonly items: LogEntry[];
  readonly nextSeq: number;
  readonly dropped: number;
  readonly more: boolean;
}

/**
 * Bounded log of console messages, exceptions, crashes and process events from every source
 * (renderer, main, process, custom): a byte ring (FR7, NFR3) that counts what it evicts.
 */
export class LogBook {
  readonly #ring: ByteRing<Omit<LogEntry, 'seq'>>;
  readonly #now: () => number;

  constructor(options: { readonly capacityBytes?: number; readonly now?: () => number } = {}) {
    this.#ring = new ByteRing({
      capacityBytes: options.capacityBytes ?? CAPS.logRingBytes,
      sizeOf: entryBytes,
    });
    this.#now = options.now ?? Date.now;
  }

  /** Record one entry (text and stack clipped, URL made safe like network URLs). */
  add(entry: NewLogEntry): void {
    const { ts, text, stack, url, ...rest } = entry;
    this.#ring.push({
      ...rest,
      ts: ts ?? this.#now(),
      text: clip(text, MAX_LOG_TEXT),
      ...(url === undefined ? {} : { url: safeUrl(url) }),
      ...(stack === undefined ? {} : { stack: clip(stack, MAX_LOG_STACK) }),
    });
  }

  query(query: LogQuery = {}): LogPage {
    const minLevel = LEVELS.indexOf(query.minLevel ?? 'debug');
    const needle = query.contains?.toLowerCase();
    const keep = (entry: Omit<LogEntry, 'seq'>): boolean =>
      LEVELS.indexOf(entry.level) >= minLevel &&
      (query.source === undefined || entry.source === query.source) &&
      (query.targetId === undefined || entry.target === query.targetId) &&
      (needle === undefined ||
        entry.text.toLowerCase().includes(needle) ||
        (entry.url?.toLowerCase().includes(needle) ?? false));
    const page = this.#ring.readMatching(query.since ?? 0, query.limit ?? CAPS.pageItems, keep);
    return {
      items: page.entries.map(({ seq, item }) => ({ seq, ...item })),
      nextSeq: page.nextSeq,
      dropped: page.dropped,
      more: page.more,
    };
  }

  lastSeq(): number {
    return this.#ring.stats.lastSeq;
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * An entry's size for the ring's budget: its string lengths plus fixed overhead, which is its JSON size
 * for ASCII text (at most 3× under for other text), without serializing every entry (console floods
 * are a hot path).
 */
function entryBytes(entry: Omit<LogEntry, 'seq'>): number {
  const strings =
    entry.text.length + (entry.stack?.length ?? 0) + (entry.url?.length ?? 0) + (entry.target?.length ?? 0);
  return strings + 96;
}
