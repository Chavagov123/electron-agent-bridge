import { ByteRing, CAPS, globMatcher, type NetworkRecord } from '@eab/core';
import { z } from 'zod';

import type { CdpEvent, CdpTransport, Disposable } from '../ports/cdp-transport.js';
import type { Clock } from '../ports/clock.js';
import { LazyDomain } from './lazy-domain.js';
import { safeUrl } from './url-privacy.js';

/** Requests followed until they finish; beyond this the oldest are forgotten (and counted). */
export const MAX_IN_FLIGHT = 1_000;

const Response = z.object({
  status: z.number(),
  mimeType: z.string().optional(),
  fromDiskCache: z.boolean().optional(),
  fromPrefetchCache: z.boolean().optional(),
  fromServiceWorker: z.boolean().optional(),
});
const RequestWillBeSent = z.object({
  requestId: z.string(),
  request: z.object({ url: z.string(), method: z.string() }),
  timestamp: z.number(),
  wallTime: z.number(),
  type: z.string().optional(),
  redirectResponse: Response.optional(),
});
const ResponseReceived = z.object({ requestId: z.string(), response: Response });
const LoadingFinished = z.object({
  requestId: z.string(),
  timestamp: z.number(),
  encodedDataLength: z.number(),
});
const LoadingFailed = z.object({
  requestId: z.string(),
  timestamp: z.number(),
  errorText: z.string(),
  canceled: z.boolean().optional(),
  blockedReason: z.string().optional(),
});
const ServedFromCache = z.object({ requestId: z.string() });

type Stored = Omit<NetworkRecord, 'seq'>;

interface InFlight {
  record: Stored;
  /** CDP monotonic seconds at send. */
  readonly startedAt: number;
}

export interface NetworkQuery {
  readonly since?: number;
  readonly limit?: number;
  readonly targetId?: string;
  /** URL glob. */
  readonly url?: string;
  readonly failedOnly?: boolean;
}

/** Start of a request reported by a source other than CDP (e.g. the main process). */
export interface ExternalRequestStart {
  readonly method: string;
  /** Raw URL; redacted here like every other. */
  readonly url: string;
  /** Wall-clock start, epoch ms. */
  readonly ts: number;
  readonly resourceType?: string;
}

/** How such a request ended. */
export interface ExternalRequestEnd {
  readonly status?: number;
  readonly mimeType?: string;
  readonly failed?: string;
  readonly encodedBytes?: number;
}

export interface NetworkLogOptions {
  readonly capacityBytes?: number;
  /** Called once, when recording starts (the first `network.query`): other sources start then too. */
  readonly onActivate?: () => void;
}

export interface NetworkPage {
  readonly items: NetworkRecord[];
  readonly nextSeq: number;
  readonly dropped: number;
  readonly more: boolean;
  /** Matching-page requests not finished yet (listed once they finish). */
  readonly inFlight: number;
}

/**
 * Request metadata of every page (FR8): method, URL (secret-looking query values redacted), type,
 * status, timing, size. Bodies are never read. A request is stored once it finishes or fails (each
 * redirect hop as its own record). `Network` is enabled lazily (first `network.query`); requests made
 * while it was off are not seen, except while an action or a wait had it on.
 */
export class NetworkLog {
  readonly #ring: ByteRing<Stored>;
  readonly #domain: LazyDomain;
  readonly #inFlight = new Map<string, InFlight>();
  #forgotten = 0;
  readonly #onActivate: (() => void) | undefined;
  #activated = false;

  constructor(clock: Clock, options: NetworkLogOptions = {}) {
    this.#onActivate = options.onActivate;
    this.#ring = new ByteRing({ capacityBytes: options.capacityBytes ?? CAPS.networkRingBytes });
    this.#domain = new LazyDomain('Network.enable', clock, {
      onEvent: (targetId, event) => {
        this.#onEvent(targetId, event);
      },
      // The old session's requests will never report back: store them as unfinished.
      onSession: (targetId) => {
        this.#abandon(targetId);
      },
    });
  }

  watch(targetId: string, transport: CdpTransport): Disposable {
    const watching = this.#domain.watch(targetId, transport);
    return {
      dispose: () => {
        watching.dispose();
        this.#abandon(targetId);
      },
    };
  }

  /** Start recording everywhere; `true` if this call started it. */
  async activate(): Promise<boolean> {
    if (!this.#activated) {
      this.#activated = true;
      try {
        this.#onActivate?.();
      } catch {
        // Another source failing to start never stops page recording.
      }
    }
    return this.#domain.activate();
  }

  /**
   * A request from a source other than CDP began (`at`: monotonic seconds, the same clock as `end`).
   * Bounded like CDP requests; the request id must be unique within `targetId`.
   */
  begin(targetId: string, requestId: string, start: ExternalRequestStart, at: number): void {
    this.#track(keyOf(targetId, requestId), {
      startedAt: at,
      record: {
        ts: Math.round(start.ts),
        target: targetId,
        requestId,
        method: start.method,
        url: safeUrl(start.url),
        ...(start.resourceType === undefined ? {} : { resourceType: start.resourceType }),
      },
    });
  }

  /** It ended (headers received, or failed); unknown ids are ignored. */
  end(targetId: string, requestId: string, end: ExternalRequestEnd, at: number): void {
    this.#finish(targetId, requestId, at, {
      ...(end.status === undefined ? {} : { status: end.status }),
      ...(end.mimeType === undefined ? {} : { mimeType: end.mimeType }),
      ...(end.failed === undefined ? {} : { failed: end.failed }),
      ...(end.encodedBytes === undefined ? {} : { encodedBytes: Math.round(end.encodedBytes) }),
    });
  }

  query(query: NetworkQuery = {}): NetworkPage {
    const matches = query.url === undefined ? undefined : globMatcher(query.url);
    const keep = (record: Stored): boolean =>
      (query.targetId === undefined || record.target === query.targetId) &&
      (matches === undefined || matches(record.url)) &&
      (query.failedOnly !== true || record.failed !== undefined || (record.status ?? 0) >= 400);
    const page = this.#ring.readMatching(query.since ?? 0, query.limit ?? CAPS.pageItems, keep);
    const inFlight = [...this.#inFlight.values()].filter(
      ({ record }) => query.failedOnly !== true && keep(record),
    ).length;
    return {
      items: page.entries.map(({ seq, item }) => ({ seq, ...item })),
      nextSeq: page.nextSeq,
      dropped: page.dropped,
      more: page.more,
      inFlight,
    };
  }

  /** Requests forgotten unfinished because too many were in flight. */
  get forgotten(): number {
    return this.#forgotten;
  }

  #onEvent(targetId: string, event: CdpEvent): void {
    switch (event.method) {
      case 'Network.requestWillBeSent':
        this.#sent(targetId, event.params);
        break;
      case 'Network.responseReceived': {
        const parsed = ResponseReceived.safeParse(event.params);
        const flight = parsed.success
          ? this.#inFlight.get(keyOf(targetId, parsed.data.requestId))
          : undefined;
        if (parsed.success && flight) flight.record = withResponse(flight.record, parsed.data.response);
        break;
      }
      case 'Network.requestServedFromCache': {
        const parsed = ServedFromCache.safeParse(event.params);
        const flight = parsed.success
          ? this.#inFlight.get(keyOf(targetId, parsed.data.requestId))
          : undefined;
        if (flight) flight.record = { ...flight.record, fromCache: true };
        break;
      }
      case 'Network.loadingFinished': {
        const parsed = LoadingFinished.safeParse(event.params);
        if (parsed.success) {
          const { requestId, timestamp, encodedDataLength } = parsed.data;
          this.#finish(targetId, requestId, timestamp, { encodedBytes: Math.round(encodedDataLength) });
        }
        break;
      }
      case 'Network.loadingFailed': {
        const parsed = LoadingFailed.safeParse(event.params);
        if (parsed.success) {
          const { requestId, timestamp, errorText, canceled, blockedReason } = parsed.data;
          const failed =
            blockedReason === undefined
              ? canceled === true
                ? 'canceled'
                : errorText
              : `blocked: ${blockedReason}`;
          this.#finish(targetId, requestId, timestamp, { failed });
        }
        break;
      }
      default:
    }
  }

  #sent(targetId: string, params: unknown): void {
    const parsed = RequestWillBeSent.safeParse(params);
    if (!parsed.success) return;
    const { requestId, request, timestamp, wallTime, type, redirectResponse } = parsed.data;
    const key = keyOf(targetId, requestId);
    // A redirect reuses the request id: the previous hop ends with the redirect response.
    const previous = this.#inFlight.get(key);
    if (previous && redirectResponse) {
      this.#inFlight.delete(key);
      this.#store(withResponse(previous.record, redirectResponse), previous.startedAt, timestamp);
    }
    this.#track(key, {
      startedAt: timestamp,
      record: {
        ts: Math.round(wallTime * 1_000),
        target: targetId,
        requestId,
        method: request.method,
        url: safeUrl(request.url),
        ...(type === undefined ? {} : { resourceType: type }),
      },
    });
  }

  #track(key: string, flight: InFlight): void {
    if (!this.#inFlight.has(key) && this.#inFlight.size >= MAX_IN_FLIGHT) {
      const oldest = this.#inFlight.keys().next().value;
      if (oldest !== undefined) this.#inFlight.delete(oldest);
      this.#forgotten++;
    }
    this.#inFlight.set(key, flight);
  }

  /** Store a page's unfinished requests as such (its session or the page itself is gone). */
  #abandon(targetId: string): void {
    for (const [key, flight] of [...this.#inFlight]) {
      if (flight.record.target !== targetId) continue;
      this.#inFlight.delete(key);
      this.#ring.push({ ...flight.record, failed: 'unfinished (page session ended)' });
    }
  }

  #finish(targetId: string, requestId: string, timestamp: number, end: Partial<Stored>): void {
    const key = keyOf(targetId, requestId);
    const flight = this.#inFlight.get(key);
    if (!flight) return;
    this.#inFlight.delete(key);
    this.#store({ ...flight.record, ...end }, flight.startedAt, timestamp);
  }

  #store(record: Stored, startedAt: number, endedAt: number): void {
    this.#ring.push({ ...record, durMs: Math.max(0, Math.round((endedAt - startedAt) * 1_000_000) / 1_000) });
  }
}

function keyOf(targetId: string, requestId: string): string {
  return `${targetId}\u0000${requestId}`;
}

function withResponse(record: Stored, response: z.infer<typeof Response>): Stored {
  const fromCache =
    response.fromDiskCache === true || response.fromPrefetchCache === true || record.fromCache === true;
  return {
    ...record,
    status: response.status,
    ...(response.mimeType ? { mimeType: response.mimeType } : {}),
    ...(fromCache ? { fromCache: true } : {}),
    ...(response.fromServiceWorker === true ? { fromServiceWorker: true } : {}),
  };
}
