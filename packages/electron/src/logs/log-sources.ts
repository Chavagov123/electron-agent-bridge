import type { LogEntry } from '@eab/core';

import { formatArgs, levelOfMethod, wrapLoggerMethods, type ReentryGuard } from './logger-wrap.js';

/** One entry a custom source reports. */
export interface CustomLogEntry {
  readonly level: LogEntry['level'];
  readonly text: string;
  readonly stack?: string;
  readonly url?: string;
}

/** Where a source writes its entries. Never throws. */
export interface LogSink {
  log(entry: CustomLogEntry): void;
}

/**
 * A pluggable log source (FR7): the app's own logger, a log file tail, anything. `install` starts
 * feeding the sink and returns how to stop. Entries appear in `logs` with source `custom`.
 */
export interface LogSource {
  readonly name: string;
  install(sink: LogSink): () => void;
}

/** The logger methods {@link loggerSource} wraps unless told otherwise. */
export const DEFAULT_LOGGER_METHODS = ['error', 'warn', 'info', 'log', 'debug', 'verbose', 'trace'] as const;

/**
 * A source that records calls to a logger object's methods (wrap and delegate: the logger behaves
 * exactly as before), e.g. `loggerSource('app', log)` for electron-log, winston, pino or console-like
 * objects. The method name decides the level; the arguments are formatted like `console.log`.
 */
export function loggerSource(
  name: string,
  logger: object,
  methods: readonly string[] = DEFAULT_LOGGER_METHODS,
): LogSource {
  return {
    name,
    install: (sink) =>
      wrapLoggerMethods(
        logger as Record<string, unknown>,
        methods,
        (method, args) => {
          sink.log({ level: levelOfMethod(method), text: formatArgs(args) });
        },
        guardOf(),
      ),
  };
}

const SOURCES_KEY = Symbol.for('electron-agent-bridge.v1.log-sources');

interface SourceRegistry {
  readonly sources: Set<LogSource>;
  readonly listeners: Set<(source: LogSource, added: boolean) => void>;
  /** Shared by every wrapped logger and the main console, across bundle copies. */
  readonly guard: ReentryGuard;
}

/** Stored on a global `Symbol.for` key so sources added through any bundle copy, or before start, are seen. */
export function sourceRegistry(): SourceRegistry {
  const slot = globalThis as unknown as Partial<Record<typeof SOURCES_KEY, SourceRegistry>>;
  let registry = slot[SOURCES_KEY];
  if (!registry) {
    registry = { sources: new Set(), listeners: new Set(), guard: { depth: 0 } };
    Object.defineProperty(slot, SOURCES_KEY, { value: registry, configurable: true, enumerable: false });
  }
  return registry;
}

/** The re-entry guard shared by all logger wrappers in this process. */
export function guardOf(): ReentryGuard {
  return sourceRegistry().guard;
}

/**
 * Add a log source. Works before or after the bridge starts, and is a harmless no-op while it is
 * off (the source is installed only by a running bridge). Returns how to remove it again.
 */
export function addLogSource(source: LogSource): () => void {
  const registry = sourceRegistry();
  registry.sources.add(source);
  for (const listener of registry.listeners) listener(source, true);
  return () => {
    if (!registry.sources.delete(source)) return;
    for (const listener of registry.listeners) listener(source, false);
  };
}
