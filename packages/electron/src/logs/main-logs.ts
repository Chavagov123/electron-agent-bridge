import type { LogEntry } from '@electron-agent-bridge/core';
import type { LogBook, NewLogEntry } from '@electron-agent-bridge/engine';
import type { App, WebContents } from 'electron';

import { safely } from '../ipc/ipc-main-wrapper.js';
import { sourceRegistry, type CustomLogEntry, type LogSource } from './log-sources.js';
import { formatArgs, levelOfMethod, wrapLoggerMethods } from './logger-wrap.js';

/** The main-process `console` methods recorded (source `main`). */
const CONSOLE_METHODS = ['error', 'warn', 'info', 'log', 'debug', 'trace'];
const LEVELS = new Set<string>(['debug', 'info', 'warn', 'error']);

/** Only `on`/`off` of the process are used: listening never changes how it handles errors. */
interface ProcessEvents {
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
}

export interface MainLogDeps {
  readonly app: App;
  readonly allWebContents: () => WebContents[];
  readonly book: LogBook;
  /** Record the main process's `console` (default on). */
  readonly mainConsole: boolean;
  /** Sources passed in the app's options (more can be added with `addLogSource`). */
  readonly sources: readonly LogSource[];
  readonly process?: ProcessEvents;
  readonly console?: object;
}

interface GoneDetails {
  readonly reason?: string;
  readonly exitCode?: number;
  readonly type?: string;
  readonly name?: string;
  readonly serviceName?: string;
}

/**
 * Main-process side of the logs (FR7): uncaught exceptions through `uncaughtExceptionMonitor` and
 * warnings (incl. unhandled rejections, which Electron's main only warns about) — observers only,
 * never `uncaughtException`/`unhandledRejection` listeners, so crashes and error dialogs stay exactly
 * as without the bridge (S12) — plus the main `console`, renderer/child process exits, preload
 * errors, failed loads and unresponsive pages, and the app's own sources.
 */
/** How Node prints a process warning: `(node:1234) [DEP0005] DeprecationWarning: …`. */
const NODE_WARNING_PRINTOUT = /^\(node:\d+\) (\[[\w-]+\] )?\w*Warning: /;

export class MainLogCapture {
  readonly #deps: MainLogDeps;
  readonly #undo: (() => void)[] = [];
  readonly #installed = new Map<LogSource, () => void>();
  /** Per live page: how to stop listening to it. */
  readonly #pages = new Set<() => void>();

  constructor(deps: MainLogDeps) {
    this.#deps = deps;
  }

  start(): void {
    this.#crashes();
    if (this.#deps.mainConsole) {
      this.#undo.push(
        wrapLoggerMethods(
          (this.#deps.console ?? console) as Record<string, unknown>,
          CONSOLE_METHODS,
          (method, args) => {
            const text = formatArgs(args);
            // Node's own printout of a process warning, recorded once (as a warning) from the event.
            if (NODE_WARNING_PRINTOUT.test(text)) return;
            this.#add({ source: 'main', level: levelOfMethod(method), text });
          },
          sourceRegistry().guard,
        ),
      );
    }
    this.#processEvents();
    this.#customSources();
  }

  /** Undo in reverse order of installation: custom sources (which may wrap `console` too) first. */
  stop(): void {
    for (const uninstall of [...this.#installed.values()].reverse()) safely(uninstall);
    this.#installed.clear();
    for (const unwatch of this.#pages) safely(unwatch);
    this.#pages.clear();
    for (const step of this.#undo.splice(0).reverse()) safely(step);
  }

  #add(entry: NewLogEntry): void {
    safely(() => {
      this.#deps.book.add(entry);
    });
  }

  #crashes(): void {
    const target: ProcessEvents = this.#deps.process ?? process;
    const onException = (error: unknown, origin: string): void => {
      const what = origin === 'unhandledRejection' ? 'Unhandled rejection' : 'Uncaught exception';
      this.#add({ source: 'main', level: 'error', text: `${what}: ${messageOf(error)}`, ...stackOf(error) });
    };
    const onWarning = (warning: unknown): void => {
      const name = warning instanceof Error ? warning.name : 'Warning';
      this.#add({ source: 'main', level: 'warn', text: `${name}: ${messageOf(warning)}` });
    };
    target.on('uncaughtExceptionMonitor', onException);
    target.on('warning', onWarning);
    this.#undo.push(() => {
      target.off('uncaughtExceptionMonitor', onException);
      target.off('warning', onWarning);
    });
  }

  #processEvents(): void {
    const { app } = this.#deps;
    const onRendererGone = (_event: unknown, contents: WebContents, details: GoneDetails): void => {
      this.#add({
        source: 'process',
        level: 'error',
        text: `Renderer process gone: ${goneText(details)}`,
        target: `wc${contents.id}`,
      });
    };
    const onChildGone = (_event: unknown, details: GoneDetails): void => {
      const label = [details.type ?? 'child', details.name ?? details.serviceName].filter(Boolean).join(' ');
      this.#add({
        source: 'process',
        level: details.reason === 'clean-exit' ? 'info' : 'error',
        text: `${label} process gone: ${goneText(details)}`,
      });
    };
    const onCreated = (_event: unknown, contents: WebContents): void => {
      this.#watchContents(contents);
    };
    app.on('render-process-gone', onRendererGone);
    app.on('child-process-gone', onChildGone);
    app.on('web-contents-created', onCreated);
    this.#undo.push(() => {
      app.off('render-process-gone', onRendererGone);
      app.off('child-process-gone', onChildGone);
      app.off('web-contents-created', onCreated);
    });
    for (const contents of this.#deps.allWebContents()) this.#watchContents(contents);
  }

  #watchContents(contents: WebContents): void {
    const target = `wc${contents.id}`;
    const onPreloadError = (_event: unknown, preloadPath: string, error: unknown): void => {
      this.#add({
        source: 'renderer',
        level: 'error',
        text: `Preload error: ${messageOf(error)}`,
        target,
        url: preloadPath,
        ...stackOf(error),
      });
    };
    const onFailLoad = (...[, code, description, url, isMainFrame]: unknown[]): void => {
      // -3 (ERR_ABORTED): a navigation replaced by another one, not a failure.
      if (code === -3) return;
      const where = isMainFrame === true ? 'Page' : 'Frame';
      this.#add({
        source: 'process',
        level: 'error',
        text: `${where} failed to load: ${String(description)} (${String(code)})`,
        target,
        ...(typeof url === 'string' && url !== '' ? { url } : {}),
      });
    };
    const onUnresponsive = (): void => {
      this.#add({ source: 'process', level: 'warn', text: 'Page became unresponsive', target });
    };
    const onResponsive = (): void => {
      this.#add({ source: 'process', level: 'info', text: 'Page is responsive again', target });
    };
    contents.on('preload-error', onPreloadError);
    contents.on('did-fail-load', onFailLoad);
    contents.on('unresponsive', onUnresponsive);
    contents.on('responsive', onResponsive);
    const unwatch = (): void => {
      this.#pages.delete(unwatch);
      if (contents.isDestroyed()) return;
      contents.off('preload-error', onPreloadError);
      contents.off('did-fail-load', onFailLoad);
      contents.off('unresponsive', onUnresponsive);
      contents.off('responsive', onResponsive);
    };
    this.#pages.add(unwatch);
    contents.once('destroyed', () => this.#pages.delete(unwatch));
  }

  #customSources(): void {
    const registry = sourceRegistry();
    const onChange = (source: LogSource, added: boolean): void => {
      if (added) this.#install(source);
      else this.#uninstall(source);
    };
    registry.listeners.add(onChange);
    this.#undo.push(() => registry.listeners.delete(onChange));
    for (const source of [...this.#deps.sources, ...registry.sources]) this.#install(source);
  }

  #install(source: LogSource): void {
    if (this.#installed.has(source)) return;
    const name = typeof source.name === 'string' ? source.name.slice(0, 64) : 'source';
    try {
      const uninstall = source.install({
        log: (entry) => {
          this.#custom(name, entry);
        },
      });
      this.#installed.set(source, typeof uninstall === 'function' ? uninstall : () => undefined);
    } catch (error) {
      this.#add({
        source: 'custom',
        level: 'error',
        text: `[${name}] log source failed: ${messageOf(error)}`,
      });
    }
  }

  #uninstall(source: LogSource): void {
    const uninstall = this.#installed.get(source);
    this.#installed.delete(source);
    if (uninstall) safely(uninstall);
  }

  #custom(name: string, entry: CustomLogEntry): void {
    safely(() => {
      const level: LogEntry['level'] = LEVELS.has(entry.level) ? entry.level : 'info';
      this.#add({
        source: 'custom',
        level,
        text: `[${name}] ${typeof entry.text === 'string' ? entry.text : formatArgs([entry.text])}`,
        ...(typeof entry.stack === 'string' ? { stack: entry.stack } : {}),
        ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
      });
    });
  }
}

function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return '[unprintable]';
  }
}

function stackOf(error: unknown): { stack?: string } {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return {};
  // The first line repeats the message.
  const frames = error.stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim());
  return frames.length === 0 ? {} : { stack: frames.join('\n') };
}

function goneText(details: GoneDetails): string {
  const code = details.exitCode === undefined ? '' : ` (exit code ${details.exitCode})`;
  return `${details.reason ?? 'unknown'}${code}`;
}
