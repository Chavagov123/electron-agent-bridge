/** Where a generated location came from, per its source map. */
export interface MappedLocation {
  readonly url: string;
  readonly line: number;
  readonly column: number;
}

/** A generated script location, 1-based as stack traces print it. */
export interface ScriptLocation {
  readonly url: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Maps generated script locations to their sources (protocol 1.1, source-map stacks). Implemented by
 * the runtime, which can read files; the engine applies it when logs are read, never when recorded.
 * Asynchronous so that a runtime can read and parse large maps away from the app's event loop. Lines
 * and columns are 1-based. Each result is `undefined` when there is no map, or no entry.
 */
export interface StackMapper {
  mapAll(locations: readonly ScriptLocation[]): Promise<readonly (MappedLocation | undefined)[]>;
}

/** The synchronous form, over locations already resolved (and in tests). */
export interface LocationMapper {
  map(url: string, line: number, column: number): MappedLocation | undefined;
}
