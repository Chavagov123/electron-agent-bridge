import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { SourceMap, type SourceMapPayload } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { LocationMapper, MappedLocation } from '@eab/engine';

/** Maps kept (least recently used evicted), counting files without one. */
const MAX_FILES = 50;
/**
 * Maps (and scripts with an inline map) larger than this are not read. Reads are synchronous, once per
 * file, in the source-map worker (see `WorkerStackMapper`): bundled apps have maps of 10 MB and more.
 */
const MAX_MAP_BYTES = 32 * 1024 * 1024;
/** Map text kept in memory across files; least recently used maps go first. */
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
/** The comment is at the end of the script: only the script's end is read for it. */
const TAIL_BYTES = 4_096;
/** A `sourceMappingURL` comment ending its line (the last one counts: a `sourceURL` line may follow). */
const MAPPING_URL = /\/[/*][#@]\s*sourceMappingURL=([^\s*]+)\s*(?:\*\/)?[ \t]*$/gm;
/** Text of a data URL: what the start of a tail cut out of an inline map looks like. */
const DATA_URL_TEXT = /^[\w+/=%.-]+$/;

interface Loaded {
  /** The script's size and change time when it was read: a rebuilt script is read again. */
  readonly stamp: string;
  readonly map: SourceMap | undefined;
  /** Directory original sources are resolved against. */
  readonly base: string;
  /** Size of the map's text, counted against {@link MAX_CACHE_BYTES}. */
  readonly bytes: number;
}

/**
 * Resolves stack locations through the scripts' source maps, read from disk on demand (`file:` URLs
 * and absolute paths only: custom protocols and remote scripts stay as they are). A script's map is
 * found from its `sourceMappingURL` comment (a file next to it, or inline as a data URL). Parsed maps
 * are cached, failures too, and the cache is bounded.
 */
export class SourceMapResolver implements LocationMapper {
  readonly #cache = new Map<string, Loaded>();
  #bytes = 0;

  map(url: string, line: number, column: number): MappedLocation | undefined {
    const path = pathOf(url);
    if (path === undefined) return undefined;
    const loaded = this.#load(path);
    if (loaded.map === undefined) return undefined;
    const entry = loaded.map.findEntry(line - 1, Math.max(0, column - 1)) as Partial<{
      originalSource: string;
      originalLine: number;
      originalColumn: number;
    }>;
    if (entry.originalSource === undefined || entry.originalLine === undefined) return undefined;
    return {
      url: sourceName(entry.originalSource, loaded.base),
      line: entry.originalLine + 1,
      column: (entry.originalColumn ?? 0) + 1,
    };
  }

  #load(path: string): Loaded {
    const stamp = stampOf(path);
    const cached = this.#cache.get(path);
    if (cached?.stamp === stamp) {
      // Re-insert: the map keeps insertion order, so the front is the least recently used.
      this.#cache.delete(path);
      this.#cache.set(path, cached);
      return cached;
    }
    this.#forget(path);
    const loaded = { ...readMap(path), stamp };
    while (
      this.#cache.size > 0 &&
      (this.#cache.size >= MAX_FILES || this.#bytes + loaded.bytes > MAX_CACHE_BYTES)
    ) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#forget(oldest);
    }
    this.#cache.set(path, loaded);
    this.#bytes += loaded.bytes;
    return loaded;
  }

  #forget(path: string): void {
    const loaded = this.#cache.get(path);
    if (loaded === undefined) return;
    this.#cache.delete(path);
    this.#bytes -= loaded.bytes;
  }
}

function readMap(path: string): Omit<Loaded, 'stamp'> {
  const none = { map: undefined, base: dirname(path), bytes: 0 };
  try {
    const reference = referenceOf(path);
    if (reference === undefined) return none;
    if (reference.startsWith('data:')) {
      const payload = decodeDataUrl(reference);
      return payload === undefined
        ? none
        : { map: new SourceMap(payload), base: dirname(path), bytes: reference.length };
    }
    const mapPath = reference.startsWith('file:')
      ? fileURLToPath(reference)
      : resolve(dirname(path), decodeURI(reference));
    const text = readBounded(mapPath);
    if (text === undefined) return none;
    return {
      map: new SourceMap(JSON.parse(text) as SourceMapPayload),
      base: dirname(mapPath),
      bytes: text.length,
    };
  } catch {
    return none;
  }
}

/**
 * The script's `sourceMappingURL`, read from its end: bundles are often larger than their maps. The
 * whole script is read only when that end starts inside what looks like an inline map's data, which is
 * longer than the end searched (with or without lines after it, such as a `sourceURL`).
 */
function referenceOf(path: string): string | undefined {
  const tail = readTail(path);
  const text = tail.text.trimEnd();
  // Matched whole within the end: a file, or a short inline map.
  const reference = [...text.matchAll(MAPPING_URL)].at(-1)?.[1];
  if (reference !== undefined) return reference;
  const firstLine = text.split('\n', 1)[0] ?? '';
  if (!tail.cut || !DATA_URL_TEXT.test(firstLine)) return undefined;
  const script = readBounded(path);
  return script === undefined ? undefined : inlineReference(script);
}

/** An inline map can be far longer than the tail searched: look for its comment anywhere at the end. */
function inlineReference(script: string): string | undefined {
  const at = script.lastIndexOf('sourceMappingURL=data:');
  if (at === -1) return undefined;
  return /^sourceMappingURL=(data:[^\s*]+)/.exec(script.slice(at))?.[1];
}

function decodeDataUrl(url: string): SourceMapPayload | undefined {
  const comma = url.indexOf(',');
  if (comma === -1) return undefined;
  const meta = url.slice(5, comma);
  const data = url.slice(comma + 1);
  const text = meta.endsWith(';base64')
    ? Buffer.from(data, 'base64').toString('utf8')
    : decodeURIComponent(data);
  return JSON.parse(text) as SourceMapPayload;
}

/** Size and change time of a file, or `missing`. */
function stampOf(path: string): string {
  try {
    const { size, mtimeMs } = statSync(path);
    return `${size}:${mtimeMs}`;
  } catch {
    return 'missing';
  }
}

function readBounded(path: string): string | undefined {
  if (statSync(path).size > MAX_MAP_BYTES) return undefined;
  return readFileSync(path, 'utf8');
}

/** The last {@link TAIL_BYTES} of a file, and whether that cut anything off. */
function readTail(path: string): { readonly text: string; readonly cut: boolean } {
  const fd = openSync(path, 'r');
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return { text: buffer.toString('utf8'), cut: size > length };
  } finally {
    closeSync(fd);
  }
}

/** A local path for `file:` URLs and absolute paths; anything else is not mapped. */
function pathOf(url: string): string | undefined {
  try {
    if (url.startsWith('file:')) return fileURLToPath(url.split(/[?#]/)[0] ?? url);
    return isAbsolute(url) && !url.includes('://') ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Original sources as a path or URL agents can open: relative ones resolve against the map's folder. */
function sourceName(source: string, base: string): string {
  if (/^[a-z][\w+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) {
    return source.startsWith('file:') ? fileURLToPath(source) : source;
  }
  return isAbsolute(source) ? source : resolve(base, source);
}

/** The `file:` URL of a path (used by tests and for symmetry with renderer stacks). */
export function fileUrlOf(path: string): string {
  return pathToFileURL(path).href;
}
