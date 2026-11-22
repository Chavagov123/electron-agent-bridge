import type { TargetKind } from '@eab/core';
import type { CdpTransport, Disposable, TargetDescriptor, TargetSource } from '@eab/engine';
import { z } from 'zod';

import { WebSocketCdpTransport, type SocketFactory } from './websocket-transport.js';

const Listed = z.array(
  z.object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    url: z.string(),
    webSocketDebuggerUrl: z.string().optional(),
  }),
);

/** How often the page list is read again (new windows appear within this). */
export const POLL_MS = 500;
/** Pages followed at once. */
export const MAX_PAGES = 50;

/** CDP target types that are pages an agent works with. Frames and workers come as child sessions. */
const KINDS: Readonly<Record<string, TargetKind>> = { page: 'window', webview: 'webview' };

interface Tracked {
  readonly id: string;
  readonly kind: TargetKind;
  title: string;
  url: string;
  readonly transport: CdpTransport;
  readonly watching: Disposable | undefined;
}

export interface RemoteTargetsDeps {
  /** `http://host:port`, the app's remote debugging endpoint. */
  readonly base: string;
  readonly fetch?: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  readonly socket?: SocketFactory;
  /** Called for each page as it is followed (log and network collectors); disposed when it goes. */
  readonly onPage?: (targetId: string, transport: CdpTransport) => Disposable;
}

/**
 * The pages of an app reached over its remote debugging port (Attach mode): `/json/list` is read now
 * and every {@link POLL_MS}, and each page gets a socket of its own. Without the runtime in the app
 * nothing is known of windows and views beyond what CDP says: every page counts as a window, none is
 * known to be focused, and DevTools pages are left out.
 */
export class RemoteTargetSource implements TargetSource {
  readonly #deps: RemoteTargetsDeps;
  readonly #tracked = new Map<string, Tracked>();
  readonly #opening = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  /** After `stop`: sockets still opening are closed as soon as they open. */
  #stopped = false;

  constructor(deps: RemoteTargetsDeps) {
    this.#deps = deps;
  }

  /** Read the page list once (and open the pages' sockets), then keep it current. */
  async start(): Promise<void> {
    await this.refresh();
    this.#timer = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, POLL_MS);
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    for (const tracked of this.#tracked.values()) {
      tracked.watching?.dispose();
      void tracked.transport.close();
    }
    this.#tracked.clear();
  }

  list(): readonly TargetDescriptor[] {
    return [...this.#tracked.values()]
      .filter((tracked) => tracked.transport.attached)
      .map((tracked, index) => ({
        id: tracked.id,
        kind: tracked.kind,
        title: tracked.title,
        url: tracked.url,
        // Unknown without the runtime: the first page stands for the focused one.
        focused: index === 0,
        transport: tracked.transport,
      }));
  }

  async refresh(): Promise<void> {
    if (this.#stopped) return;
    const fetcher = this.#deps.fetch ?? ((url: string) => fetch(url));
    const response = await fetcher(`${this.#deps.base}/json/list`);
    if (!response.ok) return;
    const listed = Listed.safeParse(await response.json());
    if (!listed.success) return;
    const live = new Set<string>();
    const opening: Promise<void>[] = [];
    for (const entry of listed.data) {
      const kind = followable(entry);
      if (kind === undefined) continue;
      live.add(entry.id);
      const tracked = this.#tracked.get(entry.id);
      if (tracked) {
        tracked.title = entry.title;
        tracked.url = entry.url;
      } else if (!this.#opening.has(entry.id) && this.#tracked.size + this.#opening.size < MAX_PAGES) {
        opening.push(this.#open(entry.id, kind, entry));
      }
    }
    for (const [id, tracked] of [...this.#tracked]) {
      if (live.has(id) && tracked.transport.attached) continue;
      this.#tracked.delete(id);
      tracked.watching?.dispose();
      void tracked.transport.close();
    }
    await Promise.all(opening);
  }

  async #open(
    id: string,
    kind: TargetKind,
    entry: { title: string; url: string; webSocketDebuggerUrl?: string | undefined },
  ): Promise<void> {
    this.#opening.add(id);
    try {
      const transport = await WebSocketCdpTransport.open(entry.webSocketDebuggerUrl ?? '', this.#deps.socket);
      if (this.#stopped) {
        await transport.close();
        return;
      }
      let watching: Disposable | undefined;
      try {
        watching = this.#deps.onPage?.(id, transport);
      } catch {
        // The page is followed even if collecting from it failed.
      }
      this.#tracked.set(id, { id, kind, title: entry.title, url: entry.url, transport, watching });
    } catch {
      // Not reachable (closing, or the port refused): the next refresh tries again.
    } finally {
      this.#opening.delete(id);
    }
  }
}

/** The kind of a listed target the source follows: pages and webviews with a socket, never DevTools. */
function followable(entry: z.infer<typeof Listed>[number]): TargetKind | undefined {
  if (entry.url.startsWith('devtools://') || entry.webSocketDebuggerUrl === undefined) return undefined;
  return KINDS[entry.type];
}
