import type { IpcFeed, IpcFeedPage } from '@eab/engine';
import {
  ByteRing,
  CAPS,
  globMatcher,
  mergeShape,
  redact,
  renderShape,
  shapeOf,
  tupleShapeOf,
  type IpcEvent,
  type MethodData,
  type ShapeNode,
} from '@eab/core';

/** Reserved for the preload's uplink to main; never recorded or listed. */
export const UPLINK_CHANNEL = '__eab:uplink';

/** Channels Electron and Chromium use themselves. */
const INTERNAL_PREFIXES = /^(?:ELECTRON_|BROWSER_|CHROME_|RENDERER_|GUEST_|IMPORT_SHARED_TEXTURE|-)/;

/** Distinct channels kept in the catalogue; more are counted, not listed (a hostile page could flood it). */
export const MAX_CHANNELS = 2_000;

/** Messages per channel and phase whose types are merged into its inferred schema; later ones are not. */
export const SCHEMA_SAMPLES = 50;

/** One message before it gets its sequence number. */
export interface IpcRecord {
  readonly channel: string;
  readonly kind: IpcEvent['kind'];
  readonly phase: IpcEvent['phase'];
  readonly side: IpcEvent['side'];
  readonly direction?: IpcEvent['direction'];
  readonly corr?: string;
  readonly correlation?: IpcEvent['correlation'];
  readonly trust?: IpcEvent['trust'];
  readonly sender?: IpcEvent['sender'];
  /** Arguments of a request, or `[result]` of a response. Recorded as a shape; values only if opted in. */
  readonly payload?: readonly unknown[];
  /** Already-computed shape (renderer records arrive without values). */
  readonly argShape?: string;
  readonly error?: string;
  readonly durMs?: number;
}

export interface IpcRecorderOptions {
  readonly capacityBytes?: number;
  /** Channel globs whose argument values (redacted) are recorded; everything else is shape-only. */
  readonly valueChannels?: readonly string[];
  readonly now?: () => number;
}

export interface IpcQuery {
  readonly since?: number;
  readonly limit?: number;
  readonly channel?: string;
  readonly kind?: IpcEvent['kind'];
  readonly includeInternal?: boolean;
  /** Include each channel's inferred request and response types. */
  readonly schemas?: boolean;
}

/** One page of `ipc.query`, plus how many channels were too many to list. */
export type IpcPage = MethodData<'ipc.query'> & { readonly channelsDropped: number };

interface ChannelStats {
  readonly kinds: Set<string>;
  count: number;
  internal: boolean;
  /** Types inferred from main-side payloads (renderer records carry shapes only). */
  request?: Inferred;
  response?: Inferred;
}

interface Inferred {
  node: ShapeNode;
  samples: number;
}

/**
 * Bounded record of IPC messages (FR5): a byte ring with sequence numbers, the catalogue of channels
 * seen (the app's IPC surface) and correlation ids. Argument values never leave the process unless the
 * app opted a channel in, and then only redacted.
 */
export class IpcRecorder implements IpcFeed {
  readonly #ring: ByteRing<Omit<IpcEvent, 'seq'>>;
  readonly #withValues: ((channel: string) => boolean)[];
  readonly #now: () => number;
  readonly #channels = new Map<string, ChannelStats>();
  /** Registered before the bridge (Electron's own handlers, or libraries loaded earlier). */
  readonly #preexisting = new Set<string>();
  #channelsDropped = 0;
  #nextCorr = 0;

  constructor(options: IpcRecorderOptions = {}) {
    this.#ring = new ByteRing({ capacityBytes: options.capacityBytes ?? CAPS.ipcRingBytes });
    this.#withValues = (options.valueChannels ?? []).map((glob) => globMatcher(glob));
    this.#now = options.now ?? Date.now;
  }

  /** A fresh correlation id for a request (its response reuses it). */
  newCorr(): string {
    this.#nextCorr += 1;
    return `c${this.#nextCorr}`;
  }

  /** Channels that already had listeners or handlers when the bridge installed. */
  markPreexisting(channels: Iterable<string>): void {
    for (const channel of channels) this.#preexisting.add(channel);
  }

  isInternal(channel: string): boolean {
    return INTERNAL_PREFIXES.test(channel) || this.#preexisting.has(channel);
  }

  /** Store one message; returns its sequence number (undefined for our own uplink or an oversized item). */
  record(input: IpcRecord): number | undefined {
    if (input.channel === UPLINK_CHANNEL) return undefined;
    const internal = this.isInternal(input.channel);
    inferFrom(this.#catalogue(input.channel, input.kind, internal), input);
    const values = this.#withValues.some((matches) => matches(input.channel));
    const event: Omit<IpcEvent, 'seq'> = {
      ts: this.#now(),
      corr: input.corr ?? this.newCorr(),
      correlation: input.correlation ?? 'exact',
      channel: input.channel,
      kind: input.kind,
      phase: input.phase,
      side: input.side,
      ...(input.direction === undefined ? {} : { direction: input.direction }),
      trust: input.trust ?? 'high',
      ...(internal ? { internal: true } : {}),
      ...(input.sender === undefined ? {} : { sender: input.sender }),
      argShape:
        input.argShape ??
        (input.error === undefined ? shapeOf(input.payload ?? []) : `error: ${input.error}`),
      ...(values && input.payload !== undefined ? { values: redact(input.payload).value } : {}),
      ...(input.durMs === undefined ? {} : { durMs: input.durMs }),
    };
    return this.#ring.push(event);
  }

  query(query: IpcQuery = {}): IpcPage {
    const matches = query.channel === undefined ? undefined : globMatcher(query.channel);
    const keep = (event: Omit<IpcEvent, 'seq'>): boolean =>
      (query.includeInternal === true || event.internal !== true) &&
      (matches === undefined || matches(event.channel)) &&
      (query.kind === undefined || event.kind === query.kind);
    const page = this.#filteredPage(query.since ?? 0, query.limit ?? 100, keep);
    return {
      ...page,
      channels: this.#catalogueFor(query.includeInternal === true, matches, query.schemas === true),
      channelsDropped: this.#channelsDropped,
    };
  }

  /** App messages after `seq` (the engine's {@link IpcFeed}: act observations, wait_for ipc). */
  since(seq: number, limit: number): IpcFeedPage {
    const page = this.query({ since: seq, limit });
    return {
      items: page.items.map(({ seq: at, channel, kind }) => ({ seq: at, channel, kind })),
      nextSeq: page.nextSeq,
    };
  }

  /** The last sequence number handed out (0 before any message). */
  lastSeq(): number {
    return this.#ring.stats.lastSeq;
  }

  /** Up to `limit` matching events after `since`; `dropped` counts what was evicted before this read. */
  #filteredPage(since: number, limit: number, keep: (event: Omit<IpcEvent, 'seq'>) => boolean) {
    const page = this.#ring.readMatching(since, limit, keep);
    return {
      items: page.entries.map(({ seq, item }) => ({ seq, ...item })),
      nextSeq: page.nextSeq,
      dropped: page.dropped,
      more: page.more,
    };
  }

  #catalogue(channel: string, kind: string, internal: boolean): ChannelStats | undefined {
    let stats = this.#channels.get(channel);
    if (!stats) {
      if (this.#channels.size >= MAX_CHANNELS) {
        this.#channelsDropped += 1;
        return undefined;
      }
      stats = { kinds: new Set(), count: 0, internal };
      this.#channels.set(channel, stats);
    }
    stats.kinds.add(kind);
    stats.count += 1;
    return stats;
  }

  #catalogueFor(
    includeInternal: boolean,
    matches: ((channel: string) => boolean) | undefined,
    schemas: boolean,
  ) {
    return [...this.#channels.entries()]
      .filter(
        ([channel, stats]) =>
          (includeInternal || !stats.internal) && (matches === undefined || matches(channel)),
      )
      .map(([channel, stats]) => ({
        channel,
        kinds: [...stats.kinds].sort(),
        count: stats.count,
        ...(schemas ? schemaOf(stats) : {}),
      }))
      .sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel));
  }
}

/** Merge one main-side payload into the channel's inferred types (the first SCHEMA_SAMPLES per phase). */
function inferFrom(stats: ChannelStats | undefined, { phase, payload, error }: IpcRecord): void {
  if (stats === undefined || payload === undefined || error !== undefined || phase === 'error') return;
  const slot = phase === 'request' ? 'request' : 'response';
  const current = stats[slot];
  if (current !== undefined && current.samples >= SCHEMA_SAMPLES) return;
  const node = tupleShapeOf(payload);
  stats[slot] =
    current === undefined
      ? { node, samples: 1 }
      : { node: mergeShape(current.node, node), samples: current.samples + 1 };
}

function schemaOf(stats: ChannelStats): {
  schema?: { request?: string; response?: string; samples: number };
} {
  if (stats.request === undefined && stats.response === undefined) return {};
  const response = stats.response?.node;
  return {
    schema: {
      ...(stats.request === undefined ? {} : { request: renderShape(stats.request.node) }),
      // A response is `[result]`: show the result's type, not a one-item tuple.
      ...(response === undefined ? {} : { response: renderShape(resultOf(response)) }),
      samples: Math.max(stats.request?.samples ?? 0, stats.response?.samples ?? 0),
    },
  };
}

function resultOf(node: ShapeNode): ShapeNode {
  const only = node.t === 'tuple' && node.items.length === 1 ? node.items[0] : undefined;
  return only === undefined ? node : only.node;
}
