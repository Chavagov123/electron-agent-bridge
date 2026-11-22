import { EventEmitter } from 'node:events';

import { LogBook } from '@eab/engine';
import type { App, WebContents } from 'electron';
import { afterEach, describe, expect, it } from 'vitest';

import { addLogSource, loggerSource, type LogSource } from './log-sources.js';
import { levelOfMethod } from './logger-wrap.js';
import { MainLogCapture } from './main-logs.js';

class FakeContents extends EventEmitter {
  destroyed = false;
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

const removals: (() => void)[] = [];
afterEach(() => {
  for (const remove of removals.splice(0)) remove();
});

function setup(options: { mainConsole?: boolean; sources?: LogSource[] } = {}) {
  const app = new EventEmitter();
  const proc = new EventEmitter();
  const printed: unknown[][] = [];
  const fakeConsole = {
    log: (...args: unknown[]) => printed.push(args),
    error: (...args: unknown[]) => printed.push(args),
    warn(...args: unknown[]) {
      printed.push(args);
      return 'returned';
    },
  };
  const existing = new FakeContents(1);
  const book = new LogBook({ now: () => 7 });
  const capture = new MainLogCapture({
    app: app as unknown as App,
    allWebContents: () => [existing as unknown as WebContents],
    book,
    mainConsole: options.mainConsole ?? true,
    sources: options.sources ?? [],
    process: proc as never,
    console: fakeConsole,
  });
  capture.start();
  const entries = () => book.query().items.map(({ source, level, text }) => `${source}/${level}: ${text}`);
  return { app, proc, fakeConsole, printed, existing, book, capture, entries };
}

describe('MainLogCapture', () => {
  it('observes uncaught exceptions and warnings without ever handling them', () => {
    const { proc, book, capture, entries } = setup();
    expect(proc.listenerCount('uncaughtException')).toBe(0);
    expect(proc.listenerCount('unhandledRejection')).toBe(0);
    proc.emit('uncaughtExceptionMonitor', new Error('boom'), 'uncaughtException');
    proc.emit('uncaughtExceptionMonitor', 'not an error', 'unhandledRejection');
    const warning = Object.assign(new Error('Unhandled promise rejection'), {
      name: 'UnhandledPromiseRejectionWarning',
    });
    proc.emit('warning', warning);
    expect(entries()).toEqual([
      'main/error: Uncaught exception: boom',
      'main/error: Unhandled rejection: not an error',
      'main/warn: UnhandledPromiseRejectionWarning: Unhandled promise rejection',
    ]);
    expect(book.query().items[0]?.stack).toMatch(/^at /);
    capture.stop();
    expect(proc.listenerCount('uncaughtExceptionMonitor') + proc.listenerCount('warning')).toBe(0);
  });

  it('records the main console after the original ran, and restores it on stop', () => {
    const { fakeConsole, printed, capture, entries } = setup();
    const originalLog = fakeConsole.log;
    fakeConsole.log('%s=%d', 'answer', 42);
    expect(fakeConsole.warn('careful', { a: 1 })).toBe('returned');
    expect(printed).toEqual([
      ['%s=%d', 'answer', 42],
      ['careful', { a: 1 }],
    ]);
    expect(entries()).toEqual(['main/info: answer=42', 'main/warn: careful { a: 1 }']);
    capture.stop();
    expect(fakeConsole.log).not.toBe(originalLog);
    fakeConsole.log('after');
    expect(entries()).toHaveLength(2);
  });

  it('skips Node’s own printout of process warnings (the warning event records them)', () => {
    const { fakeConsole, printed, entries } = setup();
    fakeConsole.error('(node:4242) [DEP0005] DeprecationWarning: Buffer() is deprecated');
    fakeConsole.error('(node:4242) ExtensionLoadWarning: Warnings loading extension');
    fakeConsole.error('(node:4242) not a warning');
    expect(printed).toHaveLength(3);
    expect(entries()).toEqual(['main/error: (node:4242) not a warning']);
  });

  it('leaves the console alone when mainConsole is off', () => {
    const { fakeConsole, entries } = setup({ mainConsole: false });
    fakeConsole.error('x');
    expect(entries()).toEqual([]);
  });

  it('records renderer and child process exits, preload errors, failed loads and hangs', () => {
    const { app, existing, entries, book, capture } = setup();
    const later = new FakeContents(2);
    app.emit('web-contents-created', {}, later);
    app.emit('render-process-gone', {}, existing, { reason: 'crashed', exitCode: 3 });
    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'oom', exitCode: 9 });
    app.emit('child-process-gone', {}, { type: 'Utility', name: 'worker', reason: 'clean-exit' });
    later.emit('preload-error', {}, '/app/preload.js', new SyntaxError('Unexpected token'));
    later.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'http://nowhere/', true);
    later.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://x/', true);
    existing.emit('did-fail-load', {}, -2, 'ERR_FAILED', '', false);
    existing.emit('unresponsive');
    existing.emit('responsive');
    expect(entries()).toEqual([
      'process/error: Renderer process gone: crashed (exit code 3)',
      'process/error: GPU process gone: oom (exit code 9)',
      'process/info: Utility worker process gone: clean-exit',
      'renderer/error: Preload error: Unexpected token',
      'process/error: Page failed to load: ERR_NAME_NOT_RESOLVED (-105)',
      'process/error: Frame failed to load: ERR_FAILED (-2)',
      'process/warn: Page became unresponsive',
      'process/info: Page is responsive again',
    ]);
    expect(book.query({ targetId: 'wc2' }).items.map((entry) => entry.url)).toEqual([
      '/app/preload.js',
      'http://nowhere/',
    ]);
    later.destroyed = true;
    later.emit('destroyed');
    capture.stop();
    expect(existing.listenerCount('unresponsive') + app.listenerCount('render-process-gone')).toBe(0);
  });

  it('installs the app’s sources from options and from addLogSource, before or after start', () => {
    const appLogger = { info: (...args: unknown[]) => args, error: (...args: unknown[]) => args };
    const early = addLogSource({
      name: 'early',
      install: (sink) => {
        sink.log({ level: 'warn', text: 'installed', stack: 'at x', url: 'file:///log' });
        return () => undefined;
      },
    });
    removals.push(early);
    const { entries, capture, book } = setup({ sources: [loggerSource('app', appLogger)] });
    appLogger.info('ready in %d ms', 12);
    const late = addLogSource({
      name: 'late',
      install: (sink) => {
        sink.log({ level: 'nonsense' as never, text: 42 as never });
        return () => undefined;
      },
    });
    const broken = addLogSource({
      name: 'broken',
      install: () => {
        throw new Error('no file');
      },
    });
    removals.push(broken);
    late();
    late();
    expect(entries()).toEqual([
      'custom/warn: [early] installed',
      'custom/info: [app] ready in 12 ms',
      'custom/info: [late] 42',
      'custom/error: [broken] log source failed: no file',
    ]);
    expect(book.query({ source: 'custom' }).items[0]).toMatchObject({ stack: 'at x', url: 'file:///log' });
    capture.stop();
    appLogger.error('after stop');
    expect(entries()).toHaveLength(4);
  });

  it('restores the console when a custom source wrapped it too', () => {
    const app = new EventEmitter();
    const target = { log: (...args: unknown[]) => args };
    const original = target.log;
    const capture = new MainLogCapture({
      app: app as unknown as App,
      allWebContents: () => [],
      book: new LogBook(),
      mainConsole: true,
      sources: [loggerSource('console-too', target)],
      process: new EventEmitter() as never,
      console: target,
    });
    capture.start();
    capture.stop();
    expect(target.log).toBe(original);
  });

  it('records a logger that logs through the console once', () => {
    const { fakeConsole, entries } = setup();
    const chained = { info: (...args: unknown[]) => fakeConsole.log(...args) };
    const remove = addLogSource(loggerSource('chained', chained));
    removals.push(remove);
    chained.info('once');
    expect(entries()).toEqual(['custom/info: [chained] once']);
  });
});

describe('loggerSource', () => {
  it('leaves a frozen logger untouched instead of failing', () => {
    const frozen = Object.freeze({ info: (...args: unknown[]) => args });
    const seen: string[] = [];
    const uninstall = loggerSource('frozen', frozen).install({ log: (entry) => seen.push(entry.text) });
    expect(frozen.info('x')).toEqual(['x']);
    expect(seen).toEqual([]);
    uninstall();
  });
});

describe('levelOfMethod', () => {
  it('maps common logger method names', () => {
    expect(['fatal', 'warning', 'silly', 'log', 'notice'].map(levelOfMethod)).toEqual([
      'error',
      'warn',
      'debug',
      'info',
      'info',
    ]);
  });
});
