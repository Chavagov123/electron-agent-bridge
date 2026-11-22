import { Worker } from 'node:worker_threads';

import type { MappedLocation, ScriptLocation, StackMapper } from '@eab/engine';

import { SOURCE_MAP_WORKER_SOURCE } from '../generated/source-map-worker-source.js';
import type { MapReply, MapRequest } from './source-map-worker.js';
import { SourceMapResolver } from './source-maps.js';

/** The worker (and the maps it holds) is let go after this long without a query. */
const IDLE_MS = 5 * 60_000;
/** Workers that died (or could not start) before maps are resolved in the main process instead. */
const MAX_FAILURES = 3;
/**
 * A request still unanswered after this long means the worker is stuck (a pathological map): it is
 * ended. After {@link MAX_FAILURES} of those, stacks stay unmapped: such a map would stall the main
 * process as well.
 */
export const REQUEST_MS = 60_000;

/** What the mapper needs of a worker thread (a fake in tests). */
export interface MapWorker {
  postMessage(request: MapRequest): void;
  on(event: 'message', listener: (reply: MapReply) => void): unknown;
  on(event: 'error' | 'exit', listener: () => void): unknown;
  unref(): void;
  terminate(): Promise<number>;
}

type Pending = (results: readonly (MappedLocation | undefined)[]) => void;

/**
 * Resolves stack locations in a worker thread that reads and caches the source maps, so the app's
 * main process never stops to read or parse one. The worker starts with the first query, does not
 * keep the app alive, and ends after {@link IDLE_MS} idle. If workers keep failing, maps are resolved
 * in the main process, as before.
 */
export class WorkerStackMapper implements StackMapper {
  readonly #spawn: () => MapWorker;
  readonly #pending = new Map<
    number,
    { readonly count: number; readonly resolve: Pending; readonly timer: ReturnType<typeof setTimeout> }
  >();
  #worker: MapWorker | undefined;
  #nextId = 1;
  #failures = 0;
  #hangs = 0;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #fallback: SourceMapResolver | undefined;

  readonly #requestMs: number;

  constructor(spawn: () => MapWorker = spawnWorker, requestMs = REQUEST_MS) {
    this.#spawn = spawn;
    this.#requestMs = requestMs;
  }

  mapAll(locations: readonly ScriptLocation[]): Promise<readonly (MappedLocation | undefined)[]> {
    if (locations.length === 0) return Promise.resolve([]);
    if (this.#hangs >= MAX_FAILURES) return Promise.resolve(locations.map(() => undefined));
    const worker = this.#ready();
    if (worker === undefined) return Promise.resolve(this.#mapHere(locations));
    this.#touch();
    const id = this.#nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#hung(worker, id);
      }, this.#requestMs);
      timer.unref();
      this.#pending.set(id, { count: locations.length, resolve, timer });
      try {
        worker.postMessage({ id, locations });
      } catch {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(this.#mapHere(locations));
      }
    });
  }

  /** The worker never answered request `id`: end it; its requests are answered unmapped. */
  #hung(worker: MapWorker, id: number): void {
    if (!this.#pending.has(id) || this.#worker !== worker) return;
    this.#hangs++;
    this.#worker = undefined;
    this.#settleAll();
    void worker.terminate().catch(() => undefined);
  }

  /** End the worker (the runtime stopped). */
  close(): void {
    if (this.#idle !== undefined) clearTimeout(this.#idle);
    this.#idle = undefined;
    const worker = this.#worker;
    this.#worker = undefined;
    this.#settleAll();
    void worker?.terminate().catch(() => undefined);
  }

  #ready(): MapWorker | undefined {
    if (this.#worker !== undefined) return this.#worker;
    if (this.#failures >= MAX_FAILURES) return undefined;
    try {
      const worker = this.#spawn();
      worker.unref();
      worker.on('message', (reply: MapReply) => {
        this.#settle(reply);
      });
      const failed = (): void => {
        if (this.#worker !== worker) return;
        this.#worker = undefined;
        this.#failures++;
        this.#settleAll();
      };
      worker.on('error', failed);
      worker.on('exit', failed);
      this.#worker = worker;
      return worker;
    } catch {
      this.#failures = MAX_FAILURES;
      return undefined;
    }
  }

  #settle({ id, results }: MapReply): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(Array.from({ length: pending.count }, (_, index) => results[index] ?? undefined));
  }

  /** Requests a dead worker will never answer are answered unmapped. */
  #settleAll(): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(Array.from({ length: pending.count }, () => undefined));
    }
  }

  #touch(): void {
    if (this.#idle !== undefined) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      if (this.#pending.size > 0) {
        this.#touch();
        return;
      }
      this.close();
    }, IDLE_MS);
    this.#idle.unref();
  }

  #mapHere(locations: readonly ScriptLocation[]): (MappedLocation | undefined)[] {
    this.#fallback ??= new SourceMapResolver();
    const resolver = this.#fallback;
    return locations.map(({ url, line, column }) => {
      try {
        return resolver.map(url, line, column);
      } catch {
        return undefined;
      }
    });
  }
}

function spawnWorker(): MapWorker {
  return new Worker(SOURCE_MAP_WORKER_SOURCE, { eval: true, name: 'eab-source-maps' });
}
