import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';

import type { ExternalRequestEnd, ExternalRequestStart } from '@eab/engine';

import { safely } from '../ipc/ipc-main-wrapper.js';

/** Target id of main-process requests in `network.query`. */
export const MAIN_TARGET = 'main';

/** Where finished requests go (the engine's network log). */
export interface NetworkSink {
  begin(targetId: string, requestId: string, start: ExternalRequestStart, at: number): void;
  end(targetId: string, requestId: string, end: ExternalRequestEnd, at: number): void;
}

/** `net` as the capture uses it: `net.fetch` goes through `net.request`, so wrapping it sees both. */
export interface NetLike {
  request: (...args: unknown[]) => unknown;
}

export interface MainNetworkDeps {
  readonly sink: NetworkSink;
  readonly net?: NetLike;
  readonly now?: () => number;
}

/** Node's diagnostics channels for its HTTP client (`http`, `https`) and for undici (global `fetch`). */
const CHANNELS = {
  httpStart: 'http.client.request.start',
  httpResponse: 'http.client.response.finish',
  httpError: 'http.client.request.error',
  undiciCreate: 'undici:request:create',
  undiciHeaders: 'undici:request:headers',
  undiciError: 'undici:request:error',
} as const;

interface NodeRequest {
  readonly method?: string;
  readonly path?: string;
  readonly host?: string;
  readonly protocol?: string;
  getHeader?: (name: string) => unknown;
}
interface NodeResponse {
  readonly statusCode?: number;
  readonly headers?: Record<string, unknown>;
}
interface UndiciRequest {
  readonly method?: string;
  readonly origin?: unknown;
  readonly path?: string;
}
interface UndiciResponse {
  readonly statusCode?: number;
  readonly headers?: readonly unknown[];
}

type Listener = (message: unknown) => void;

/**
 * Request metadata of the main process (protocol 1.1), into the same log as the pages' with target
 * `main`: Node's `http`/`https` and global `fetch` through Node's diagnostics channels (observed, not
 * patched), and Electron's `net.request`/`net.fetch` through a delegating wrapper. A request ends when
 * its response headers arrive or it fails: bodies are never read, so `durMs` is the time to headers.
 * Nothing runs until recording starts (the first `network.query`).
 */
export class MainNetworkCapture {
  readonly #deps: MainNetworkDeps;
  readonly #ids = new WeakMap<object, string>();
  readonly #listeners: [string, Listener][] = [];
  #next = 1;
  #active = false;
  #undoNet: (() => void) | undefined;

  constructor(deps: MainNetworkDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#listen(CHANNELS.httpStart, (message) => {
      const request = (message as { request?: NodeRequest }).request;
      if (request) this.#begin(request, request.method ?? 'GET', nodeUrl(request), 'Node http');
    });
    this.#listen(CHANNELS.httpResponse, (message) => {
      const { request, response } = message as { request?: object; response?: NodeResponse };
      if (request)
        this.#end(request, {
          ...statusOf(response?.statusCode),
          ...mimeOf(response?.headers?.['content-type']),
        });
    });
    this.#listen(CHANNELS.httpError, (message) => {
      const { request, error } = message as { request?: object; error?: unknown };
      if (request) this.#end(request, { failed: messageOf(error) });
    });
    this.#listen(CHANNELS.undiciCreate, (message) => {
      const request = (message as { request?: UndiciRequest }).request;
      if (request)
        this.#begin(
          request,
          request.method ?? 'GET',
          `${String(request.origin)}${request.path ?? ''}`,
          'fetch',
        );
    });
    this.#listen(CHANNELS.undiciHeaders, (message) => {
      const { request, response } = message as { request?: object; response?: UndiciResponse };
      if (request)
        this.#end(request, {
          ...statusOf(response?.statusCode),
          ...mimeOf(undiciHeader(response?.headers, 'content-type')),
        });
    });
    this.#listen(CHANNELS.undiciError, (message) => {
      const { request, error } = message as { request?: object; error?: unknown };
      if (request) this.#end(request, { failed: messageOf(error) });
    });
    this.#wrapNet();
  }

  stop(): void {
    this.#active = false;
    for (const [name, listener] of this.#listeners.splice(0)) {
      safely(() => {
        unsubscribe(name, listener);
      });
    }
    this.#undoNet?.();
    this.#undoNet = undefined;
  }

  #listen(name: string, listener: Listener): void {
    const guarded: Listener = (message) => {
      if (!this.#active) return;
      safely(() => {
        listener(message);
      });
    };
    subscribe(name, guarded);
    this.#listeners.push([name, guarded]);
  }

  #wrapNet(): void {
    const net = this.#deps.net;
    if (net === undefined || typeof net.request !== 'function') return;
    const original = net.request;
    const watch = (created: unknown, options: unknown): void => {
      if (!this.#active) return;
      safely(() => {
        this.#watchNet(created, options);
      });
    };
    const request = function (this: unknown, ...args: unknown[]): unknown {
      const created = original.apply(this, args);
      watch(created, args[0]);
      return created;
    };
    net.request = request;
    this.#undoNet = () => {
      if (net.request === request) net.request = original;
    };
  }

  /** Electron's ClientRequest: `response` gives the status, `error`/`abort` end it as failed. */
  #watchNet(created: unknown, options: unknown): void {
    const request = created as { on?: (event: string, listener: (...args: unknown[]) => void) => unknown };
    if (typeof request.on !== 'function') return;
    const { method, url } = netTarget(options);
    this.#begin(created as object, method, url, 'net');
    request.on('response', (response: unknown) => {
      safely(() => {
        const { statusCode, headers } = response as {
          statusCode?: number;
          headers?: Record<string, unknown>;
        };
        this.#end(created as object, { ...statusOf(statusCode), ...mimeOf(headers?.['content-type']) });
      });
    });
    request.on('error', (error: unknown) => {
      safely(() => {
        this.#end(created as object, { failed: messageOf(error) });
      });
    });
    request.on('abort', () => {
      safely(() => {
        this.#end(created as object, { failed: 'canceled' });
      });
    });
  }

  #begin(request: object, method: string, url: string, resourceType: string): void {
    const id = `m${this.#next++}`;
    this.#ids.set(request, id);
    this.#deps.sink.begin(MAIN_TARGET, id, { method, url, ts: Date.now(), resourceType }, this.#now());
  }

  #end(request: object, end: ExternalRequestEnd): void {
    const id = this.#ids.get(request);
    if (id === undefined) return;
    this.#ids.delete(request);
    this.#deps.sink.end(MAIN_TARGET, id, end, this.#now());
  }

  /** Monotonic seconds, the clock CDP timestamps use. */
  #now(): number {
    return (this.#deps.now ?? (() => performance.now()))() / 1_000;
  }
}

function nodeUrl(request: NodeRequest): string {
  const host = safelyHeader(request) ?? request.host ?? 'localhost';
  return `${request.protocol ?? 'http:'}//${host}${request.path ?? '/'}`;
}

function safelyHeader(request: NodeRequest): string | undefined {
  try {
    const host = request.getHeader?.('host');
    return typeof host === 'string' ? host : undefined;
  } catch {
    return undefined;
  }
}

/** `net.request(url | options)` → method and URL. */
function netTarget(options: unknown): { method: string; url: string } {
  if (typeof options === 'string') return { method: 'GET', url: options };
  if (options instanceof URL) return { method: 'GET', url: options.href };
  const value = (options ?? {}) as Record<string, unknown>;
  const method = typeof value['method'] === 'string' ? value['method'].toUpperCase() : 'GET';
  if (typeof value['url'] === 'string') return { method, url: value['url'] };
  const protocol = typeof value['protocol'] === 'string' ? value['protocol'] : 'http:';
  const port =
    typeof value['port'] === 'number' || typeof value['port'] === 'string' ? `:${value['port']}` : '';
  const hostname = typeof value['hostname'] === 'string' ? value['hostname'] : 'localhost';
  const host = typeof value['host'] === 'string' ? value['host'] : `${hostname}${port}`;
  return { method, url: `${protocol}//${host}${typeof value['path'] === 'string' ? value['path'] : '/'}` };
}

function undiciHeader(headers: readonly unknown[] | undefined, name: string): unknown {
  if (!Array.isArray(headers)) return undefined;
  for (let index = 0; index + 1 < headers.length; index += 2) {
    if (String(headers[index]).toLowerCase() === name) return String(headers[index + 1]);
  }
  return undefined;
}

function statusOf(status: unknown): { status?: number } {
  return typeof status === 'number' && Number.isInteger(status) ? { status } : {};
}

function mimeOf(contentType: unknown): { mimeType?: string } {
  const value: unknown = Array.isArray(contentType) ? (contentType as unknown[])[0] : contentType;
  if (typeof value !== 'string') return {};
  const mime = value.split(';')[0]?.trim();
  return mime ? { mimeType: mime.slice(0, 100) } : {};
}

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return (typeof message === 'string' ? message : String(error)).slice(0, 200);
}
