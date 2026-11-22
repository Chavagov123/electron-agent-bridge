import type { LogEntry } from '@eab/core';

import type { LocationMapper, MappedLocation, ScriptLocation, StackMapper } from '../ports/stack-mapper.js';
import { isOwnCode } from './console-format.js';
import { LATE, withDeadline } from './deadline.js';

/** `at fn (url:line:col)`, `at url:line:col` and Firefox-style `fn@url:line:col` frames. */
const FRAME = /^(\s*(?:at\s+(?:[^(]*?\s+\()?|[^@\s]*@))(.+):(\d+):(\d+)(\)?)\s*$/;
/** Frames mapped per entry; the rest stay as they are. */
const MAX_FRAMES = 20;
/**
 * How long a query waits for the runtime to resolve locations (it may be reading large maps for the
 * first time); after that the entries are returned as recorded and the maps finish loading meanwhile.
 */
export const MAP_DEADLINE_MS = 2_000;

type Entry = Omit<LogEntry, 'seq' | 'ts'>;

/** Lines of a message's text searched for frames (React appends a component stack to warnings). */
const TEXT_LINES = 60;

/** One stack frame: where it pointed as recorded, and where it points now (mapped or not). */
interface Frame {
  readonly recorded: { readonly url: string; readonly line: number };
  readonly at: MappedLocation;
  readonly mapped: boolean;
}

/**
 * Rewrite an entry's stack frames and its location to their original sources where a source map says
 * so, and mark it `mapped`. The location moves with its stack frame: to the first frame of the app's
 * own code from there on (a console wrapper in a dependency is not where a message was written), else
 * to that frame's mapped place. A location that is not in the stack stays as recorded; one without a
 * stack is mapped by its column. Frames in the message text (React's component stack) are mapped too;
 * when the stack has none of the app's own code, the first of the text's places the location.
 * Entries without anything to map are returned unchanged.
 */
export function mapEntry<T extends Entry>(entry: T, mapper: LocationMapper): T {
  const textLines = entry.text.split('\n');
  const inText = textLines.length > 1 ? mapFrames(textLines, mapper, 1, TEXT_LINES) : undefined;
  const fromText = inText?.find((frame) => frame.mapped && isOwnCode(frame.at.url));
  const text = inText === undefined ? {} : { text: textLines.join('\n') };
  if (entry.stack === undefined) {
    const located = mapLocation(entry, mapper);
    if (inText === undefined) return located;
    const own = located.url !== undefined && isOwnCode(located.url) && located.mapped === true;
    const place = own || fromText === undefined ? {} : placeOf(fromText);
    return { ...located, ...text, ...place, mapped: true };
  }
  const lines = entry.stack.split('\n');
  const frames = mapFrames(lines, mapper, 0, MAX_FRAMES);
  if (frames === undefined && inText === undefined) return entry;
  const at = locationIn(entry, frames ?? [], fromText);
  return {
    ...entry,
    ...text,
    ...(at === undefined ? {} : placeOf(at)),
    stack: lines.join('\n'),
    mapped: true,
  };
}

/** The frame that places an entry with a stack (see {@link mapEntry}). */
function locationIn(entry: Entry, frames: readonly Frame[], fromText: Frame | undefined): Frame | undefined {
  const start = frames.findIndex(
    (frame) => frame.recorded.url === entry.url && frame.recorded.line === entry.line,
  );
  if (start === -1) return fromText;
  return frames.slice(start).find((frame) => isOwnCode(frame.at.url)) ?? fromText ?? frames[start];
}

function placeOf({ at }: Frame): Pick<Entry, 'url' | 'line' | 'column'> {
  return { url: at.url, line: at.line, column: at.column };
}

/**
 * Map the frames among `lines[from…from+scan)` in place (at most {@link MAX_FRAMES}); `undefined` when
 * none could be mapped.
 */
function mapFrames(lines: string[], mapper: LocationMapper, from: number, scan: number): Frame[] | undefined {
  const frames: Frame[] = [];
  let mapped = false;
  for (let index = from; index < Math.min(lines.length, from + scan) && frames.length < MAX_FRAMES; index++) {
    const match = FRAME.exec(lines[index] ?? '');
    if (!match) continue;
    const [, head = '', url = '', row = '', column = '', close = ''] = match;
    const recorded = { url, line: Number(row), column: Number(column) };
    const location = safeMap(mapper, url, recorded.line, recorded.column);
    if (location !== undefined) {
      lines[index] = `${head}${location.url}:${location.line}:${location.column}${close}`;
      mapped = true;
    }
    frames.push({ recorded, at: location ?? recorded, mapped: location !== undefined });
  }
  return mapped ? frames : undefined;
}

/** A location without a stack: mappable when its column was recorded (minified code needs it). */
function mapLocation<T extends Entry>(entry: T, mapper: LocationMapper): T {
  if (entry.url === undefined || entry.line === undefined || entry.column === undefined) return entry;
  const location = safeMap(mapper, entry.url, entry.line, entry.column);
  if (location === undefined) return entry;
  return { ...entry, url: location.url, line: location.line, column: location.column, mapped: true };
}

function safeMap(
  mapper: LocationMapper,
  url: string,
  line: number,
  column: number,
): MappedLocation | undefined {
  if (!valid(line, column)) return undefined;
  try {
    return mapper.map(url, line, column);
  } catch {
    return undefined;
  }
}

export interface MappedEntries<T> {
  readonly items: T[];
  /** The mapper did not answer within the deadline: entries are as recorded. */
  readonly late: boolean;
}

/**
 * Map a page of entries with one batched call: every frame and stackless location is resolved at once,
 * then each entry is rewritten by {@link mapEntry}. A mapper that fails or answers after `deadlineMs`
 * leaves the entries as recorded (`late`), never failing the query.
 */
export async function mapEntries<T extends Entry>(
  entries: readonly T[],
  mapper: StackMapper,
  deadlineMs = MAP_DEADLINE_MS,
): Promise<MappedEntries<T>> {
  const wanted = new Map<string, ScriptLocation>();
  for (const entry of entries) {
    for (const location of locationsOf(entry)) wanted.set(keyOf(location), location);
  }
  if (wanted.size === 0) return { items: [...entries], late: false };
  const locations = [...wanted.values()];
  const results = await withDeadline(mapper.mapAll(locations), deadlineMs);
  if (results === LATE) return { items: [...entries], late: true };
  if (results === undefined) return { items: [...entries], late: false };
  const table = new Map<string, MappedLocation>();
  locations.forEach((location, index) => {
    const result = results[index];
    if (result !== undefined) table.set(keyOf(location), result);
  });
  const lookup: LocationMapper = {
    map: (url, line, column) => table.get(keyOf({ url, line, column })),
  };
  return { items: entries.map((entry) => mapEntry(entry, lookup)), late: false };
}

/** What {@link mapEntry} would ask the mapper for: found by running it with a mapper that only listens. */
function locationsOf(entry: Entry): ScriptLocation[] {
  const found: ScriptLocation[] = [];
  mapEntry(entry, {
    map: (url, line, column) => {
      found.push({ url, line, column });
      return undefined;
    },
  });
  return found;
}

function valid(line: number, column: number): boolean {
  return Number.isSafeInteger(line) && Number.isSafeInteger(column) && line >= 1;
}

function keyOf({ url, line, column }: ScriptLocation): string {
  return `${String(line)}:${String(column)}:${url}`;
}
