import { basename } from 'node:path';

import type { NewLogEntry } from '@eab/engine';

import { safely } from './ipc-main-wrapper.js';
import type { IpcRecorder } from './ipc-recorder.js';

/** The part of a `UtilityProcess` child the capture touches. */
export interface UtilityChildLike {
  readonly pid?: number | undefined;
  postMessage: (this: unknown, message: unknown, transfer?: unknown[]) => void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Electron's `utilityProcess` module: only `fork` is used. */
export interface UtilityProcessLike {
  fork: (modulePath: string, args?: string[], options?: { serviceName?: string }) => UtilityChildLike;
}

export interface UtilityCaptureDeps {
  readonly utilityProcess: UtilityProcessLike | undefined;
  readonly recorder: IpcRecorder;
  readonly recording: { readonly value: boolean };
  readonly log: (entry: NewLogEntry) => void;
}

/**
 * Records messages between main and the app's utility processes (`utilityProcess.fork`): what main
 * posts (`direction: out`) and what the child posts back (`in`), on the channel `utility:<name>`.
 * The fork wrapper delegates unchanged; per child, `postMessage` is wrapped on the instance and a
 * listener of our own observes `message`. Stdout and stderr are never read: attaching a `data`
 * listener would switch the streams to flowing mode, and the app could lose output it reads later.
 */
export class UtilityCapture {
  readonly #deps: UtilityCaptureDeps;
  #undo: (() => void) | undefined;
  /** False after `stop`: children forked earlier keep their wrappers, as pass-throughs. */
  #active = false;

  constructor(deps: UtilityCaptureDeps) {
    this.#deps = deps;
  }

  start(): void {
    const module = this.#deps.utilityProcess;
    if (module === undefined || typeof module.fork !== 'function') return;
    const original = module.fork;
    this.#active = true;
    const watch = (child: UtilityChildLike, args: Parameters<UtilityProcessLike['fork']>): void => {
      if (!this.#active) return;
      safely(() => {
        this.#watch(child, args);
      });
    };
    const fork = function (this: unknown, ...args: Parameters<UtilityProcessLike['fork']>): UtilityChildLike {
      const child = original.apply(this, args);
      watch(child, args);
      return child;
    };
    module.fork = fork;
    this.#undo = () => {
      this.#active = false;
      // Restore only if nobody wrapped it after us; otherwise stay as a pass-through.
      if (module.fork === fork) module.fork = original;
    };
  }

  stop(): void {
    this.#undo?.();
    this.#undo = undefined;
  }

  #watch(child: UtilityChildLike, [modulePath, , options]: Parameters<UtilityProcessLike['fork']>): void {
    const { recorder, recording, log } = this.#deps;
    const name = options?.serviceName ?? basename(modulePath);
    const channel = `utility:${name}`;
    const sender = (): { target: string } | undefined =>
      child.pid === undefined ? undefined : { target: `u${child.pid}` };
    const record = (direction: 'out' | 'in', message: unknown): void => {
      if (!recording.value || !this.#active) return;
      const from = sender();
      recorder.record({
        channel,
        kind: 'utilityMessage',
        phase: 'request',
        side: direction === 'out' ? 'main' : 'utility',
        direction,
        payload: [message],
        ...(from === undefined ? {} : { sender: from }),
      });
    };
    const originalPost = child.postMessage;
    child.postMessage = function (this: unknown, message: unknown, transfer?: unknown[]): void {
      safely(() => {
        record('out', message);
      });
      // Same arity as the caller used: some APIs check `arguments.length`.
      if (transfer === undefined) {
        originalPost.call(this, message);
        return;
      }
      originalPost.call(this, message, transfer);
    };
    child.on('message', (message: unknown) => {
      safely(() => {
        record('in', message);
      });
    });
    child.on('spawn', () => {
      safely(() => {
        if (recording.value)
          log({
            source: 'process',
            level: 'info',
            text: `Utility ${name} started (pid ${String(child.pid)})`,
          });
      });
    });
  }
}
