import { safely } from './ipc-main-wrapper.js';
import type { IpcRecorder } from './ipc-recorder.js';

/** The `MessagePortMain` prototype methods the capture patches. */
interface PortPrototype {
  postMessage: (this: object, message: unknown, transfer?: unknown[]) => void;
  emit: (this: object, event: string | symbol, ...args: unknown[]) => boolean;
}

/** `new MessageChannelMain()`: only its ports' shared prototype is used. */
export type MessageChannelFactory = () => { port1: object; port2: object };

export interface PortCaptureDeps {
  readonly createChannel: MessageChannelFactory | undefined;
  readonly recorder: IpcRecorder;
  readonly recording: { readonly value: boolean };
}

/**
 * Records messages on every `MessagePortMain` in main: posted (`direction: out`) and received (`in`),
 * on the channel `port:p<n>` (one id per port, kept while the port lives). `MessageChannelMain` cannot
 * be replaced (its export is a fixed getter), so the shared port prototype is patched once:
 * `postMessage` and `emit('message')` record, then delegate unchanged. Ports in renderers are the web's
 * `MessagePort` and are not seen.
 */
export class PortCapture {
  readonly #deps: PortCaptureDeps;
  readonly #ids = new WeakMap<object, string>();
  #next = 1;
  #undo: (() => void) | undefined;

  constructor(deps: PortCaptureDeps) {
    this.#deps = deps;
  }

  start(): void {
    const prototype = this.#prototype();
    if (prototype === undefined) return;
    const { postMessage: originalPost, emit: originalEmit } = prototype;
    let active = true;
    const record = (port: object, direction: 'out' | 'in', message: unknown): void => {
      if (!active) return;
      safely(() => {
        this.#record(port, direction, message);
      });
    };
    const postMessage: PortPrototype['postMessage'] = function (message, transfer) {
      record(this, 'out', message);
      if (transfer === undefined) {
        originalPost.call(this, message);
        return;
      }
      originalPost.call(this, message, transfer);
    };
    const emit: PortPrototype['emit'] = function (event, ...args) {
      if (event === 'message') record(this, 'in', (args[0] as { data?: unknown } | undefined)?.data);
      return originalEmit.call(this, event, ...args);
    };
    prototype.postMessage = postMessage;
    prototype.emit = emit;
    this.#undo = () => {
      active = false;
      if (prototype.postMessage === postMessage) prototype.postMessage = originalPost;
      // `emit` was inherited (EventEmitter); removing our own property restores exactly that.
      if (prototype.emit === emit) Reflect.deleteProperty(prototype, 'emit');
    };
  }

  stop(): void {
    this.#undo?.();
    this.#undo = undefined;
  }

  /** The id agents see for a port. */
  idOf(port: object): string {
    let id = this.#ids.get(port);
    if (id === undefined) {
      id = `p${this.#next++}`;
      this.#ids.set(port, id);
    }
    return id;
  }

  #record(port: object, direction: 'out' | 'in', message: unknown): void {
    if (!this.#deps.recording.value) return;
    const id = this.idOf(port);
    this.#deps.recorder.record({
      channel: `port:${id}`,
      kind: 'portMessage',
      phase: 'request',
      side: 'main',
      direction,
      payload: [message],
      sender: { target: id },
    });
  }

  /** One throwaway channel, closed at once, to reach the ports' prototype. */
  #prototype(): PortPrototype | undefined {
    const create = this.#deps.createChannel;
    if (create === undefined) return undefined;
    try {
      const { port1, port2 } = create();
      const prototype = Object.getPrototypeOf(port1) as PortPrototype | null;
      for (const port of [port1, port2]) {
        safely(() => {
          (port as { close?: () => void }).close?.();
        });
      }
      if (typeof prototype?.postMessage !== 'function' || typeof prototype.emit !== 'function')
        return undefined;
      return prototype;
    } catch {
      return undefined;
    }
  }
}
