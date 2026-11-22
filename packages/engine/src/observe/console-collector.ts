import type { CdpEvent, CdpTransport, Disposable } from '../ports/cdp-transport.js';
import type { Clock } from '../ports/clock.js';
import {
  ConsoleApiCalled,
  ExceptionThrown,
  SILENT_CONSOLE_TYPES,
  consoleText,
  describeObject,
  levelOf,
  locationOf,
} from './console-format.js';
import { LazyDomain, type SessionChange } from './lazy-domain.js';
import type { LogBook, NewLogEntry } from './log-book.js';
import { Gaps, type PageRange } from './gaps.js';

/** Recent messages remembered per page to recognise a replay (Chromium stores about a thousand). */
const MAX_REMEMBERED = 2_000;

/**
 * Console messages recorded per page and second, with bursts up to {@link CONSOLE_BURST} (a replay of
 * the stored messages fits). Beyond that, messages are counted, not recorded: a flood then costs the
 * main process little more than Electron delivering the events (ADR-0010). Exceptions are never capped.
 */
export const CONSOLE_RATE_PER_SECOND = 1_000;
export const CONSOLE_BURST = 2_000;

interface Budget {
  tokens: number;
  at: number;
  /** Messages not recorded since the last one that was. */
  skipped: number;
}

/** Per page: recent messages by key (time, level, text) with counts, and a replay in progress. */
interface Seen {
  readonly recent: Map<string, number>;
  high: number;
  /** After a re-attach: what may be replayed (counts still to skip) and up to which time. */
  replay?: { readonly pending: Map<string, number>; readonly until: number };
}

/**
 * Renderer console messages and uncaught exceptions of every page (FR7), into the {@link LogBook}.
 * `Runtime` is enabled lazily (first `logs.query`); enabling replays the messages the page stored
 * since its last load, so earlier ones are not lost. A fresh CDP session (re-attach) replays them
 * again: right after one, messages already recorded are skipped, each as often as it was recorded.
 */
export class ConsoleCollector {
  readonly #book: LogBook;
  readonly #domain: LazyDomain;
  readonly #seen = new Map<string, Seen>();
  readonly #budgets = new Map<string, Budget>();
  readonly #clock: Clock;
  readonly #capped = new Gaps();

  constructor(book: LogBook, clock: Clock) {
    this.#book = book;
    this.#clock = clock;
    this.#domain = new LazyDomain('Runtime.enable', clock, {
      onEvent: (targetId, event) => {
        this.#onEvent(targetId, event);
      },
      onSession: (targetId, change) => {
        this.#onSession(targetId, change);
      },
    });
  }

  watch(targetId: string, transport: CdpTransport): Disposable {
    const watching = this.#domain.watch(targetId, transport);
    return {
      dispose: () => {
        watching.dispose();
        this.#seen.delete(targetId);
        this.#budgets.delete(targetId);
      },
    };
  }

  /** Start capturing everywhere; `true` if this call started it. */
  activate(): Promise<boolean> {
    return this.#domain.activate();
  }

  #onSession(targetId: string, change: SessionChange): void {
    const seen = this.#seen.get(targetId);
    if (change === 'attach' && seen && seen.recent.size > 0) {
      seen.replay = { pending: new Map(seen.recent), until: seen.high };
    }
  }

  /** Console messages not recorded within `range` (of `targetId`, if given): a page logged too fast. */
  cappedIn(range: PageRange, targetId?: string): number {
    return this.#capped.within(range, targetId);
  }

  #onEvent(targetId: string, event: CdpEvent): void {
    if (event.method === 'Runtime.consoleAPICalled') {
      if (this.#allow(targetId)) this.#console(targetId, event.params);
    } else if (event.method === 'Runtime.exceptionThrown') this.#exception(targetId, event.params);
  }

  /** Token bucket per page; when messages come in again after a cap, says how many were left out. */
  #allow(targetId: string): boolean {
    const now = this.#clock.now();
    const budget = this.#budgets.get(targetId) ?? { tokens: CONSOLE_BURST, at: now, skipped: 0 };
    this.#budgets.set(targetId, budget);
    budget.tokens = Math.min(
      CONSOLE_BURST,
      budget.tokens + ((now - budget.at) * CONSOLE_RATE_PER_SECOND) / 1_000,
    );
    budget.at = now;
    if (budget.tokens < 1) {
      budget.skipped++;
      this.#capped.note(this.#book.lastSeq(), targetId);
      return false;
    }
    budget.tokens--;
    this.#noteSkipped(targetId, budget);
    return true;
  }

  /**
   * Write the "not recorded" entry of every page still over the cap, so what a query reads ends with a
   * record after each gap (and a reader sees the flood even while it lasts).
   */
  flush(): void {
    for (const [targetId, budget] of this.#budgets) this.#noteSkipped(targetId, budget);
  }

  #noteSkipped(targetId: string, budget: Budget): void {
    if (budget.skipped === 0) return;
    this.#book.add({
      source: 'process',
      level: 'warn',
      text: `Console flood: ${budget.skipped} message(s) from this page were not recorded (over ${CONSOLE_RATE_PER_SECOND}/s)`,
      target: targetId,
    });
    budget.skipped = 0;
  }

  #console(targetId: string, params: unknown): void {
    const call = plainCall(params) ?? ConsoleApiCalled.safeParse(params).data;
    if (call === undefined || SILENT_CONSOLE_TYPES.has(call.type)) return;
    const { type, args, timestamp, stackTrace } = call;
    const level = levelOf(type);
    const { stack, ...where } = locationOf(stackTrace);
    // Stacks only where they help: errors, warnings, console.trace.
    const keepStack = level === 'error' || level === 'warn' || type === 'trace';
    this.#add(targetId, timestamp, {
      source: 'renderer',
      level,
      text: consoleText(args),
      target: targetId,
      ...where,
      ...(keepStack && stack !== undefined ? { stack } : {}),
    });
  }

  #exception(targetId: string, params: unknown): void {
    const parsed = ExceptionThrown.safeParse(params);
    if (!parsed.success) return;
    const details = parsed.data.exceptionDetails;
    const { exception } = details;
    // An Error's description is its own stack (headline, then frames); a thrown value has none.
    const [headline, ...frames] =
      exception?.description === undefined
        ? [exception === undefined ? '' : describeObject(exception)]
        : exception.description.split('\n');
    const location = locationOf(details.stackTrace);
    const url = details.url === undefined || details.url === '' ? location.url : details.url;
    const stack = frames.length > 0 ? frames.map((frame) => frame.trim()).join('\n') : location.stack;
    this.#add(targetId, parsed.data.timestamp, {
      source: 'renderer',
      level: 'error',
      text: headline ? `${details.text} ${headline}` : details.text,
      target: targetId,
      ...(url === undefined ? {} : { url }),
      ...(details.lineNumber === undefined ? {} : { line: details.lineNumber + 1 }),
      // With the column, a stackless exception in minified code can be mapped to its source.
      ...(details.lineNumber === undefined || details.columnNumber === undefined
        ? {}
        : { column: details.columnNumber + 1 }),
      ...(stack === undefined ? {} : { stack }),
    });
  }

  #add(targetId: string, timestamp: number, entry: NewLogEntry): void {
    // Enough to tell messages apart (time, level, length, start), and cheap to hash in floods.
    const key = `${timestamp}\u0000${entry.level}\u0000${entry.text.length}\u0000${entry.text.slice(0, 64)}`;
    let seen = this.#seen.get(targetId);
    if (!seen) {
      seen = { recent: new Map(), high: Number.NEGATIVE_INFINITY };
      this.#seen.set(targetId, seen);
    }
    if (seen.replay && timestamp > seen.replay.until) delete seen.replay;
    const replayed = seen.replay?.pending.get(key) ?? 0;
    if (replayed > 0) {
      seen.replay?.pending.set(key, replayed - 1);
      return;
    }
    seen.recent.set(key, (seen.recent.get(key) ?? 0) + 1);
    if (seen.recent.size > MAX_REMEMBERED) {
      const oldest = seen.recent.keys().next().value;
      if (oldest !== undefined) seen.recent.delete(oldest);
    }
    seen.high = Math.max(seen.high, timestamp);
    this.#book.add({ ...entry, ts: timestamp });
  }
}

type ConsoleCall = NonNullable<ReturnType<typeof ConsoleApiCalled.safeParse>['data']>;

/**
 * The common case without a full schema walk: a call whose arguments are all strings or numbers and
 * whose stack frames are well formed. Anything else (objects, previews, odd shapes) goes through the
 * schema. Console floods make this a hot path.
 */
function plainCall(params: unknown): ConsoleCall | undefined {
  const call = params as { type?: unknown; args?: unknown; timestamp?: unknown; stackTrace?: unknown } | null;
  if (typeof call?.type !== 'string' || typeof call.timestamp !== 'number' || !Array.isArray(call.args)) {
    return undefined;
  }
  for (const arg of call.args as { type?: unknown; value?: unknown }[]) {
    const simple =
      (arg.type === 'string' && typeof arg.value === 'string') ||
      (arg.type === 'number' && typeof arg.value === 'number');
    if (!simple) return undefined;
  }
  if (call.stackTrace !== undefined && !wellFormedFrames(call.stackTrace)) return undefined;
  return call as ConsoleCall;
}

function wellFormedFrames(stackTrace: unknown): boolean {
  const frames = (stackTrace as { callFrames?: unknown } | null)?.callFrames;
  if (!Array.isArray(frames)) return false;
  return (frames as Record<string, unknown>[]).every(
    (frame) =>
      typeof frame['functionName'] === 'string' &&
      typeof frame['url'] === 'string' &&
      typeof frame['lineNumber'] === 'number' &&
      typeof frame['columnNumber'] === 'number',
  );
}
