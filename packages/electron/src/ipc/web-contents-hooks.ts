import type { WebContents } from 'electron';

import { safely, wrapIpcTarget, type IpcTarget, type WrapContext } from './ipc-main-wrapper.js';

type Send = (this: unknown, ...args: unknown[]) => unknown;

interface Hooked {
  readonly ipc?: IpcTarget;
  readonly mainFrame?: { readonly ipc?: IpcTarget };
  send: Send;
  postMessage: Send;
  sendToFrame: Send;
}

/**
 * Per page: wrap its own `ipc` and its frames' `ipc` (handlers scoped to one page or frame), record
 * outbound messages to the renderer, and fall back to the documented `ipc-message(-sync)` events for
 * messages no wrapped listener recorded (no listener, or one registered before the bridge). Undo
 * returned; also undone when the page is destroyed.
 */
export function hookWebContents(contents: WebContents, context: WrapContext): () => void {
  const page = contents as unknown as Hooked;
  const undo: (() => void)[] = [];
  if (page.ipc) undo.push(wrapIpcTarget(page.ipc, context));
  if (page.mainFrame?.ipc) undo.push(wrapIpcTarget(page.mainFrame.ipc, context));
  const onFrame = (_event: unknown, details: { frame?: { ipc?: IpcTarget } | null }): void => {
    if (details.frame?.ipc) undo.push(wrapIpcTarget(details.frame.ipc, context));
  };
  contents.on('frame-created', onFrame);
  undo.push(() => contents.off('frame-created', onFrame));
  undo.push(wrapOutbound(contents, page, context));
  undo.push(documentedEvents(contents, context));
  undo.push(forgetWaitsWhenGone(contents, context));
  return () => {
    for (const step of undo.reverse()) safely(step);
  };
}

/** A destroyed or crashed page waits on nothing any more. */
function forgetWaitsWhenGone(contents: WebContents, context: WrapContext): () => void {
  const page = `wc${contents.id}`;
  const forget = (): void => {
    context.waits?.clear(page);
  };
  contents.on('render-process-gone', forget);
  contents.on('destroyed', forget);
  return () => {
    contents.off('render-process-gone', forget);
    contents.off('destroyed', forget);
  };
}

/** `send`, `postMessage` and `sendToFrame` to this page: kind `toRenderer`. */
function wrapOutbound(contents: WebContents, page: Hooked, context: WrapContext): () => void {
  const target = { target: `wc${contents.id}` };
  const originals = { send: page.send, postMessage: page.postMessage, sendToFrame: page.sendToFrame };
  const record = (channel: unknown, payload: unknown[], frameId?: unknown): void => {
    safely(() => {
      if (!context.recording.value || typeof channel !== 'string') return;
      const sender = typeof frameId === 'number' ? { ...target, frameId } : target;
      context.recorder.record({
        channel,
        kind: 'toRenderer',
        phase: 'request',
        side: 'main',
        sender,
        payload,
      });
    });
  };
  const patch = {
    send(this: unknown, ...args: unknown[]) {
      const [channel, ...payload] = args;
      record(channel, payload);
      return originals.send.apply(this, args);
    },
    postMessage(this: unknown, ...args: unknown[]) {
      const [channel, message] = args;
      record(channel, [message]);
      return originals.postMessage.apply(this, args);
    },
    sendToFrame(this: unknown, ...args: unknown[]) {
      const [frameId, channel, ...payload] = args;
      record(channel, payload, Array.isArray(frameId) ? frameId[1] : frameId);
      return originals.sendToFrame.apply(this, args);
    },
  };
  Object.assign(page, patch);
  return () => {
    for (const name of ['send', 'postMessage', 'sendToFrame'] as const) {
      if (page[name] === patch[name]) page[name] = originals[name];
    }
  };
}

/**
 * Messages no wrapped listener recorded: seen only through these events (heuristic). They fire before
 * the listeners (ipcMain, page, frame), which run synchronously in the same emit; a microtask later we
 * know whether one of them recorded the message.
 */
function documentedEvents(contents: WebContents, context: WrapContext): () => void {
  const onMessage =
    (sync: boolean) =>
    (event: { frameId?: number }, channel: string, ...payload: unknown[]) => {
      if (typeof event !== 'object') return;
      // Tells the listeners about to run that this message is a sendSync.
      if (sync) context.syncEvents.add(event);
      queueMicrotask(() => {
        recordUnseen(event, channel, payload);
      });
    };
  const recordUnseen = (event: { frameId?: number }, channel: string, payload: unknown[]): void => {
    safely(() => {
      if (!context.recording.value || context.seen.has(event)) return;
      context.seen.add(event);
      const sync = context.syncEvents.has(event);
      const sender = {
        target: `wc${contents.id}`,
        ...(event.frameId === undefined ? {} : { frameId: event.frameId }),
      };
      context.recorder.record({
        channel,
        kind: sync ? 'sendSync' : 'send',
        phase: 'request',
        side: 'main',
        correlation: 'heuristic',
        sender,
        payload,
      });
    });
  };
  const async = onMessage(false);
  const sync = onMessage(true);
  contents.on('ipc-message', async);
  contents.on('ipc-message-sync', sync);
  return () => {
    contents.off('ipc-message', async);
    contents.off('ipc-message-sync', sync);
  };
}
