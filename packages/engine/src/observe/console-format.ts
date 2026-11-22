import type { LogEntry } from '@eab/core';
import { z } from 'zod';

const PreviewProperty = z.object({ name: z.string(), value: z.string().optional(), type: z.string() });
const RemoteObject = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  value: z.unknown().optional(),
  unserializableValue: z.string().optional(),
  description: z.string().optional(),
  preview: z
    .object({ subtype: z.string().optional(), properties: z.array(PreviewProperty), overflow: z.boolean() })
    .optional(),
});
type RemoteObject = z.infer<typeof RemoteObject>;

export const StackTrace = z.object({
  callFrames: z.array(
    z.object({
      functionName: z.string(),
      url: z.string(),
      lineNumber: z.number(),
      columnNumber: z.number(),
    }),
  ),
});
type StackTrace = z.infer<typeof StackTrace>;

export const ConsoleApiCalled = z.object({
  type: z.string(),
  args: z.array(RemoteObject),
  timestamp: z.number(),
  stackTrace: StackTrace.optional(),
});

export const ExceptionThrown = z.object({
  timestamp: z.number(),
  exceptionDetails: z.object({
    text: z.string(),
    url: z.string().optional(),
    lineNumber: z.number().optional(),
    columnNumber: z.number().optional(),
    stackTrace: StackTrace.optional(),
    exception: RemoteObject.optional(),
  }),
});

/** Console calls that carry no message of their own. */
export const SILENT_CONSOLE_TYPES = new Set(['clear', 'endGroup', 'profile', 'profileEnd']);

/** `console.*` call type → log level. */
export function levelOf(type: string): LogEntry['level'] {
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'warning') return 'warn';
  if (type === 'debug' || type === 'trace' || type === 'verbose') return 'debug';
  return 'info';
}

/** The text the DevTools console would show: format directives applied, objects previewed. */
export function consoleText(args: readonly RemoteObject[]): string {
  const [first, ...rest] = args;
  if (first === undefined) return '';
  if (first.type !== 'string' || typeof first.value !== 'string') return args.map(describeObject).join(' ');
  const remaining = [...rest];
  const formatted = first.value.replace(/%([sdifoOc%])/g, (directive: string, kind: string) => {
    if (kind === '%') return '%';
    const arg = remaining.shift();
    if (arg === undefined) return directive;
    if (kind === 'c') return '';
    if (kind === 'd' || kind === 'i') return String(Math.trunc(Number(arg.value ?? Number.NaN)));
    if (kind === 'f') return String(Number(arg.value ?? Number.NaN));
    return describeObject(arg);
  });
  return [formatted, ...remaining.map(describeObject)].join(' ');
}

/** One value as the DevTools console shows it. */
export function describeObject(object: RemoteObject): string {
  if (object.unserializableValue !== undefined) return object.unserializableValue;
  if (object.type === 'string') return String(object.value);
  if (object.type === 'undefined') return 'undefined';
  if (object.subtype === 'null') return 'null';
  if (object.type !== 'object' && object.type !== 'function') {
    return object.value === undefined ? (object.description ?? object.type) : JSON.stringify(object.value);
  }
  // Errors carry their stack in the description; plain objects and arrays read better previewed.
  if (object.subtype !== 'error' && object.preview) {
    const array = object.preview.subtype === 'array';
    const parts = object.preview.properties.map(({ name, value, type }) => {
      const shown = type === 'string' ? JSON.stringify(value ?? '') : (value ?? type);
      return array ? shown : `${name}: ${shown}`;
    });
    if (object.preview.overflow) parts.push('…');
    return array ? `[${parts.join(', ')}]` : `{${parts.join(', ')}}`;
  }
  return object.description ?? object.type;
}

/** Frames kept as text: console wrappers (extensions, error reporters, loggers) come first. */
const STACK_FRAMES = 10;
/** Scripts that are never where a message was written: extensions, DevTools, the runtime's own. */
const FOREIGN_SCRIPT = /^(?:chrome-extension|devtools|extensions|chrome|node|electron):/i;

/** Whether a script is the app's own code: not an extension or the runtime, not a dependency. */
export function isOwnCode(url: string): boolean {
  return url !== '' && !FOREIGN_SCRIPT.test(url) && !/[\\/]node_modules[\\/]/.test(url);
}

/** The frame a message is attributed to: the first of the app's own code, else the first real one. */
export function attributedIndex(urls: readonly string[]): number {
  const own = urls.findIndex(isOwnCode);
  if (own !== -1) return own;
  const real = urls.findIndex((url) => url !== '' && !FOREIGN_SCRIPT.test(url));
  return real === -1 ? 0 : real;
}

/**
 * Where a message came from, and up to {@link STACK_FRAMES} frames as text. The location skips the
 * frames of console wrappers (a DevTools extension's hook, an error reporter's console patch) where
 * the stack shows the code that called them.
 */
export function locationOf(
  stack: StackTrace | undefined,
): Pick<LogEntry, 'url' | 'line' | 'column' | 'stack'> {
  const frames = (stack?.callFrames ?? []).slice(0, STACK_FRAMES);
  if (frames.length === 0) return {};
  const lines = frames.map(
    (frame) =>
      `at ${frame.functionName || '<anonymous>'} (${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`,
  );
  const at = frames[attributedIndex(frames.map((frame) => frame.url))];
  const where =
    at === undefined || at.url === ''
      ? {}
      : { url: at.url, line: at.lineNumber + 1, column: at.columnNumber + 1 };
  return { ...where, stack: lines.join('\n') };
}
