import type { IpcEvent } from '@eab/core';

import type { CorrelationQueue } from './correlation.js';
import type { IpcRecord, IpcRecorder } from './ipc-recorder.js';
import type { SyncWaits } from './sync-waits.js';

type Listener = (this: unknown, ...args: unknown[]) => unknown;

/** What `ipcMain`, `webContents.ipc` and `WebFrameMain.ipc` have in common. */
export interface IpcTarget {
  handle(channel: string, listener: Listener): void;
  handleOnce(channel: string, listener: Listener): void;
  on(channel: string, listener: Listener): unknown;
  once(channel: string, listener: Listener): unknown;
  addListener(channel: string, listener: Listener): unknown;
  removeListener(channel: string, listener: Listener): unknown;
  off(channel: string, listener: Listener): unknown;
}

export interface WrapContext {
  readonly recorder: IpcRecorder;
  readonly correlation: CorrelationQueue;
  /** Events already recorded (a message reaching several listeners is one message). */
  readonly seen: WeakSet<object>;
  /** Events of `sendSync` messages (marked by the documented `ipc-message-sync` event, which fires first). */
  readonly syncEvents: WeakSet<object>;
  /** What the listeners of a `sendSync` event get when only a proxy can see its return value. */
  readonly proxies: WeakMap<object, object>;
  /** `sendSync` messages still unanswered, per page (absent: not tracked). */
  readonly waits?: SyncWaits;
  /** Targets already wrapped (Electron reports the main frame through `frame-created` too). */
  readonly wrapped: WeakSet<object>;
  /** Cleared when the capture stops: wrappers then only delegate. */
  readonly recording: { value: boolean };
}

interface SenderEvent {
  readonly sender?: { readonly id?: number };
  readonly frameId?: number;
}

const METHODS = ['handle', 'handleOnce', 'on', 'once', 'addListener', 'removeListener', 'off'] as const;

/**
 * Wrap the registration methods of an IPC target so every handler and listener records what it
 * receives, then delegates unchanged: same `this`, arguments, return value (the app's own promise)
 * and exceptions. Removal finds the wrapper of the listener the app passes. A target is wrapped once.
 * The returned undo stops wrapping new listeners but keeps the methods: listeners registered while
 * wrapped stay removable with the app's own functions (restoring the originals would orphan them).
 */
export function wrapIpcTarget(target: IpcTarget, context: WrapContext): () => void {
  if (context.wrapped.has(target)) return () => undefined;
  context.wrapped.add(target);
  let active = true;
  // Kept unbound on purpose: every call below passes the target as `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originals = Object.fromEntries(METHODS.map((name) => [name, target[name]])) as Pick<
    IpcTarget,
    (typeof METHODS)[number]
  >;
  const wrappers = new WeakMap<Listener, Map<string, Listener>>();
  const wrapperFor = (channel: string, listener: Listener, make: () => Listener): Listener => {
    let byChannel = wrappers.get(listener);
    if (!byChannel) {
      byChannel = new Map();
      wrappers.set(listener, byChannel);
    }
    let wrapper = byChannel.get(channel);
    if (!wrapper) {
      wrapper = make();
      byChannel.set(channel, wrapper);
    }
    return wrapper;
  };
  const registered = (channel: string, listener: Listener): Listener =>
    wrappers.get(listener)?.get(channel) ?? listener;

  // Electron's handleOnce calls this.handle, Node's once calls this.on: calls made from inside one of
  // our methods go straight to the originals, or a listener would be wrapped (and recorded) twice.
  let inside = 0;
  const run = <T>(work: () => T): T => {
    inside++;
    try {
      return work();
    } finally {
      inside--;
    }
  };
  const listening = (name: 'on' | 'once' | 'addListener') =>
    function register(this: unknown, channel: string, listener: Listener): unknown {
      if (inside > 0 || !active) return originals[name].call(this, channel, listener);
      const wrapper = wrapperFor(channel, listener, () => listenerWrapper(channel, listener, context));
      return run(() => originals[name].call(this, channel, wrapper));
    };
  const handling = (name: 'handle' | 'handleOnce') =>
    function register(this: unknown, channel: string, listener: Listener): void {
      if (inside > 0 || !active) {
        originals[name].call(this, channel, listener);
        return;
      }
      const wrapper = handlerWrapper(channel, listener, context);
      run(() => {
        originals[name].call(this, channel, wrapper);
      });
    };
  const patch: Pick<IpcTarget, (typeof METHODS)[number]> = {
    handle: handling('handle'),
    handleOnce: handling('handleOnce'),
    on: listening('on'),
    once: listening('once'),
    addListener: listening('addListener'),
    removeListener(channel, listener) {
      return originals.removeListener.call(this, channel, registered(channel, listener));
    },
    off(channel, listener) {
      return originals.off.call(this, channel, registered(channel, listener));
    },
  };
  Object.assign(target, patch);
  return () => {
    active = false;
  };
}

/** `handle`: request and response (or error) share one correlation id; the duration is measured. */
function handlerWrapper(channel: string, listener: Listener, context: WrapContext): Listener {
  return function handler(this: unknown, ...args: unknown[]) {
    const [event, ...payload] = args as [SenderEvent, ...unknown[]];
    const corr = context.recorder.newCorr();
    const started = performance.now();
    const base = { channel, side: 'main' as const, corr, ...senderOf(event) };
    if (!context.recording.value) return listener.apply(this, args);
    safely(() => {
      context.recorder.record({ ...base, kind: 'invoke', phase: 'request', payload });
      context.correlation.push(keyOf(event, channel), corr);
    });
    const finish = (phase: IpcEvent['phase'], result: Pick<IpcRecord, 'payload' | 'error'>): void => {
      safely(() =>
        context.recorder.record({
          ...base,
          kind: 'handle',
          phase,
          durMs: performance.now() - started,
          ...result,
        }),
      );
    };
    let result: unknown;
    try {
      result = listener.apply(this, args);
    } catch (error) {
      finish('error', { error: messageOf(error) });
      throw error;
    }
    if (isThenable(result)) {
      // A side branch: the app's own promise is returned unchanged.
      Promise.resolve(result).then(
        (value) => {
          finish('response', { payload: [value] });
        },
        (error: unknown) => {
          finish('error', { error: messageOf(error) });
        },
      );
    } else {
      finish('response', { payload: [result] });
    }
    return result;
  };
}

/**
 * `on`/`once`: one record per message (several listeners share it), made before the first listener
 * runs. For `sendSync`, the value a listener sets on `event.returnValue` is recorded as the response,
 * and still reaches Electron unchanged (see `observeReturnValue`).
 */
function listenerWrapper(channel: string, listener: Listener, context: WrapContext): Listener {
  return function onMessage(this: unknown, ...args: unknown[]) {
    const [event, ...payload] = args as [SenderEvent, ...unknown[]];
    let delivered = event;
    safely(() => {
      if (!context.recording.value || typeof event !== 'object') return;
      if (!context.seen.has(event)) {
        context.seen.add(event);
        const sync = context.syncEvents.has(event) || hasOwnReturnValue(event);
        const corr = context.recorder.newCorr();
        const base = { channel, side: 'main' as const, corr, ...senderOf(event) };
        context.recorder.record({ ...base, kind: sync ? 'sendSync' : 'send', phase: 'request', payload });
        context.correlation.push(keyOf(event, channel), corr);
        if (sync) {
          const page = base.sender?.target;
          const end = page === undefined ? undefined : context.waits?.begin(page, channel);
          const observed = observeReturnValue(event, (value) => {
            end?.();
            safely(() =>
              context.recorder.record({ ...base, kind: 'sendSync', phase: 'response', payload: [value] }),
            );
          });
          // Unobservable: the reply would never end the wait.
          if (observed === undefined) end?.();
          else if (observed !== event) context.proxies.set(event, observed);
        }
      }
      delivered = context.proxies.get(event) ?? event;
    });
    return delivered === event ? listener.apply(this, args) : listener.call(this, delivered, ...payload);
  };
}

function hasOwnReturnValue(event: object): boolean {
  return Object.getOwnPropertyDescriptor(event, 'returnValue') !== undefined;
}

interface ReplyChannel {
  sendReply?: (this: unknown, ...args: unknown[]) => unknown;
}

/**
 * Observe the value a listener returns to `sendSync`, still passing it on to Electron. Electron has
 * done this three ways: a configurable setter (wrapped in place); a fixed setter that calls the
 * event's own `_replyChannel.sendReply` (Electron ≤ 42: that one method is wrapped on this event's
 * channel); a native write-only property that JavaScript cannot wrap (Electron 45). For the last, the
 * listeners get a proxy of the event that sees the assignment and forwards it, with the event's own
 * methods bound to the event. Returns the event the listeners get, or `undefined` when the value cannot
 * be observed (the listeners then get the event itself).
 */
function observeReturnValue(event: object, observe: (value: unknown) => void): object | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(event, 'returnValue');
  // Called with the event as `this` below.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const set = descriptor?.set;
  if (set !== undefined && descriptor?.configurable === true) {
    Object.defineProperty(event, 'returnValue', {
      ...descriptor,
      set(this: unknown, value: unknown) {
        set.call(this, value);
        observe(value);
      },
    });
    return event;
  }
  if (set !== undefined) {
    const channel = (event as { _replyChannel?: ReplyChannel })._replyChannel;
    const sendReply = channel?.sendReply;
    if (channel && typeof sendReply === 'function') {
      channel.sendReply = function observedReply(this: unknown, ...args: unknown[]) {
        observe(args[0]);
        return sendReply.apply(this, args);
      };
      return event;
    }
    return undefined;
  }
  return descriptor === undefined ? undefined : observingProxy(event, observe);
}

function observingProxy(event: object, observe: (value: unknown) => void): object {
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(event, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function' || Object.prototype.hasOwnProperty.call(target, property)) {
        return value;
      }
      // Native methods (`preventDefault`) must run on the event itself.
      if (!bound.has(property)) bound.set(property, (value as Listener).bind(target));
      return bound.get(property);
    },
    set(target, property, value: unknown) {
      const done = Reflect.set(target, property, value, target);
      if (property === 'returnValue') observe(value);
      return done;
    },
  });
}

/** The sending page and frame, as target ids agents know from `targets`. */
export function senderOf(event: SenderEvent): Pick<IpcRecord, 'sender'> {
  const id = event.sender?.id;
  if (id === undefined) return {};
  return {
    sender: { target: `wc${id}`, ...(event.frameId === undefined ? {} : { frameId: event.frameId }) },
  };
}

/** Requests are matched first-in, first-out per page, frame and channel (ADR-0003). */
export function keyOf(event: SenderEvent, channel: string): string {
  return `${event.sender?.id ?? '?'}:${event.frameId ?? '?'}:${channel}`;
}

/** Recording must never change what the app sees. */
export function safely(record: () => void): void {
  try {
    record();
  } catch {
    // Dropped: the app's IPC goes on unaffected.
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
