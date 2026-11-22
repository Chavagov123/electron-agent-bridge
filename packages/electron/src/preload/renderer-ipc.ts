/**
 * Session frame preload (ADR-0003): runs before the app's own preload in every main frame and webview
 * and shares its `ipcRenderer`. Records what the renderer sends (shapes only, never values) and
 * reports it to main in batches on the reserved uplink channel, after the app's own message.
 * Bundled by scripts/build-preload.mjs into a self-contained script; it may only require `electron`
 * (sandboxed preloads cannot load anything else).
 */
import { shapeOf } from '@eab/core';
import { contextBridge, ipcRenderer } from 'electron';

/** One uplink message: records since the last one, how many did not fit, and which preload sent it. */
export interface UplinkBatch {
  /** Random per preload load: request ids restart at 1 in every frame and after every reload. */
  readonly instance: string;
  readonly dropped: number;
  readonly records: readonly UplinkRecord[];
}

/** What a renderer record looks like on the uplink; main validates every field. */
export interface UplinkRecord {
  readonly rid?: number;
  readonly channel: string;
  readonly kind: 'send' | 'sendSync' | 'invoke' | 'postMessage' | 'bridgeCall';
  readonly phase: 'request' | 'response' | 'error';
  readonly argShape: string;
  readonly durMs?: number;
}

const UPLINK = '__eab:uplink';
const MAX_QUEUE = 500;
const INSTALLED = Symbol.for('electron-agent-bridge.v1.preload');

type Method = (this: unknown, channel: string, ...args: unknown[]) => unknown;
interface Renderer {
  send: Method;
  sendSync: Method;
  invoke: Method;
  postMessage: Method;
}

/** How deep an exposed API object is walked for functions to record. */
const MAX_DEPTH = 3;
const MAX_CHANNEL = 256;

type Expose = (this: unknown, key: string, api: unknown) => void;
interface Bridge {
  exposeInMainWorld?: Expose;
  exposeInIsolatedWorld?: (this: unknown, worldId: number, key: string, api: unknown) => void;
}

/** Request ids, shared by IPC and bridge calls: main pairs responses by (page, frame, instance, id). */
let nextRid = 0;

const scope = globalThis as Record<symbol, unknown>;
if (scope[INSTALLED] !== true) {
  scope[INSTALLED] = true;
  const push = install(ipcRenderer as unknown as Renderer);
  try {
    installBridge(contextBridge, push);
  } catch {
    // No contextBridge here (or it refuses to be read): IPC is still recorded.
  }
}

function install(renderer: Renderer): (record: UplinkRecord) => void {
  const originalSend = renderer.send;
  const instance = Math.random().toString(36).slice(2, 12);
  let queue: UplinkRecord[] = [];
  let dropped = 0;
  let scheduled = false;
  const flush = (): void => {
    scheduled = false;
    const batch: UplinkBatch = { instance, dropped, records: queue };
    queue = [];
    dropped = 0;
    if (batch.records.length > 0 || batch.dropped > 0) originalSend.call(renderer, UPLINK, batch);
  };
  const push = (record: UplinkRecord): void => {
    if (queue.length < MAX_QUEUE) queue.push(record);
    else dropped++;
    if (!scheduled) {
      scheduled = true;
      // After the app's own message has left: main sees the message first, then our record of it.
      setTimeout(flush, 0);
    }
  };
  const safely = (record: () => void): void => {
    try {
      record();
    } catch {
      // Recording never changes what the app sees.
    }
  };
  const simple = (kind: 'send' | 'postMessage', original: Method): Method =>
    function recorded(this: unknown, channel, ...args) {
      // The uplink is ours alone: whatever else sends on it (e.g. a generic `send` an app exposes to the
      // page) is dropped, so a page cannot forge records.
      if (channel === UPLINK) return undefined;
      safely(() => {
        if (typeof channel === 'string') push({ channel, kind, phase: 'request', argShape: shapeOf(args) });
      });
      return original.call(this, channel, ...args);
    };
  const originalInvoke = renderer.invoke;
  renderer.send = simple('send', originalSend);
  const originalSendSync = renderer.sendSync;
  // The renderer is the one place that always sees what a sendSync returned.
  renderer.sendSync = function sendSync(this: unknown, channel, ...args) {
    const rid = ++nextRid;
    const started = performance.now();
    safely(() => {
      if (typeof channel === 'string')
        push({ rid, channel, kind: 'sendSync', phase: 'request', argShape: shapeOf(args) });
    });
    const result = originalSendSync.call(this, channel, ...args);
    safely(() => {
      if (typeof channel === 'string') {
        push({
          rid,
          channel,
          kind: 'sendSync',
          phase: 'response',
          argShape: shapeOf([result]),
          durMs: performance.now() - started,
        });
      }
    });
    return result;
  };
  renderer.postMessage = simple('postMessage', renderer.postMessage);
  renderer.invoke = function invoke(this: unknown, channel, ...args) {
    const rid = ++nextRid;
    const started = performance.now();
    safely(() => {
      if (typeof channel === 'string')
        push({ rid, channel, kind: 'invoke', phase: 'request', argShape: shapeOf(args) });
    });
    const result = originalInvoke.call(this, channel, ...args);
    const settle = (phase: 'response' | 'error', argShape: string): void => {
      safely(() => {
        if (typeof channel === 'string')
          push({ rid, channel, kind: 'invoke', phase, argShape, durMs: performance.now() - started });
      });
    };
    Promise.resolve(result).then(
      (value) => {
        settle('response', shapeOf([value]));
      },
      (error: unknown) => {
        settle('error', `error: ${messageOf(error)}`.slice(0, 500));
      },
    );
    return result;
  };
  return (record) => {
    safely(() => {
      push(record);
    });
  };
}

/**
 * Wrap `contextBridge.exposeInMainWorld` (and `exposeInIsolatedWorld`): the functions of the exposed API
 * are recorded as `bridgeCall` on the channel `bridge:<key>.<path>` (shapes and durations only), then
 * called unchanged. Plain objects are copied with their functions wrapped, as contextBridge copies them
 * anyway; anything else is passed as it is.
 */
function installBridge(bridge: Bridge, push: (record: UplinkRecord) => void): void {
  const wrapFunction = (fn: (...args: unknown[]) => unknown, channel: string) =>
    function bridged(this: unknown, ...args: unknown[]): unknown {
      const rid = ++nextRid;
      const started = performance.now();
      const report = (phase: UplinkRecord['phase'], argShape: string): void => {
        try {
          push({
            rid,
            channel,
            kind: 'bridgeCall',
            phase,
            argShape,
            ...(phase === 'request' ? {} : { durMs: performance.now() - started }),
          });
        } catch {
          // Recording never changes what the page sees.
        }
      };
      report('request', shapeOf(args));
      let result: unknown;
      try {
        result = fn.apply(this, args);
      } catch (error) {
        report('error', `error: ${messageOf(error)}`.slice(0, 500));
        throw error;
      }
      if (typeof (result as { then?: unknown } | null)?.then === 'function') {
        (result as Promise<unknown>).then(
          (value) => {
            report('response', shapeOf([value]));
          },
          (error: unknown) => {
            report('error', `error: ${messageOf(error)}`.slice(0, 500));
          },
        );
      } else {
        report('response', shapeOf([result]));
      }
      return result;
    };
  const wrap = (value: unknown, path: string, depth: number): unknown => {
    if (typeof value === 'function') return wrapFunction(value as (...args: unknown[]) => unknown, path);
    if (depth >= MAX_DEPTH || typeof value !== 'object' || value === null) return value;
    const prototype: unknown = Object.getPrototypeOf(value);
    // Plain objects only (any realm): their prototype is null or a root prototype. Class instances
    // lose their methods through contextBridge anyway; they pass through untouched.
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return value;
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      copy[key] = wrap(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`.slice(0, MAX_CHANNEL),
        depth + 1,
      );
    }
    return copy;
  };
  const exposeInMain = bridge.exposeInMainWorld;
  if (typeof exposeInMain === 'function') {
    bridge.exposeInMainWorld = function exposeInMainWorld(this: unknown, key, api) {
      exposeInMain.call(this, key, safeWrap(api, key));
    };
  }
  const exposeInIsolated = bridge.exposeInIsolatedWorld;
  if (typeof exposeInIsolated === 'function') {
    bridge.exposeInIsolatedWorld = function exposeInIsolatedWorld(this: unknown, worldId, key, api) {
      exposeInIsolated.call(this, worldId, key, safeWrap(api, key));
    };
  }
  function safeWrap(api: unknown, key: unknown): unknown {
    try {
      return wrap(api, `bridge:${String(key)}`.slice(0, MAX_CHANNEL), 0);
    } catch {
      return api;
    }
  }
}

/** Duck-typed: errors may come from another realm, where `instanceof Error` is false. */
function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(error);
}
