import { describe, expect, it } from 'vitest';

import { FakeCdpTransport } from '../testing/fake-cdp-transport.js';
import { FakeClock } from '../testing/fake-clock.js';
import { CONSOLE_BURST, CONSOLE_RATE_PER_SECOND, ConsoleCollector } from './console-collector.js';
import { consoleText, levelOf, locationOf } from './console-format.js';
import { LogBook, MAX_LOG_TEXT } from './log-book.js';

const str = (value: string) => ({ type: 'string', value });
const frame = { functionName: 'save', url: 'file:///app/renderer.js', lineNumber: 9, columnNumber: 4 };

function consoleEvent(type: string, args: object[], timestamp: number) {
  return {
    method: 'Runtime.consoleAPICalled',
    params: { type, args, timestamp, executionContextId: 1, stackTrace: { callFrames: [frame] } },
  };
}

function setup() {
  const book = new LogBook({ now: () => 5 });
  const collector = new ConsoleCollector(book, new FakeClock());
  const page = new FakeCdpTransport().handle('Runtime.enable', () => ({}));
  const watching = collector.watch('wc1', page);
  return { book, collector, page, watching };
}

describe('console format', () => {
  it('applies format directives and previews objects like the DevTools console', () => {
    expect(
      consoleText([
        str('%s has %d items%c!'),
        str('cart'),
        { type: 'number', value: 3.7 },
        str('color: red'),
      ]),
    ).toBe('cart has 3 items!');
    expect(consoleText([str('100%% done'), { type: 'number', value: 1 }])).toBe('100% done 1');
    expect(consoleText([str('%o and %f'), { type: 'object', description: 'Object' }])).toBe('Object and %f');
    expect(
      consoleText([
        {
          type: 'object',
          preview: {
            properties: [
              { name: 'id', value: '7', type: 'number' },
              { name: 'name', value: 'x', type: 'string' },
            ],
            overflow: true,
          },
        },
        {
          type: 'object',
          subtype: 'array',
          preview: {
            subtype: 'array',
            properties: [{ name: '0', value: '1', type: 'number' }],
            overflow: false,
          },
        },
        { type: 'object', subtype: 'null' },
        { type: 'undefined' },
        { type: 'bigint', unserializableValue: '5n' },
        {
          type: 'object',
          subtype: 'error',
          description: 'Error: no',
          preview: { properties: [], overflow: false },
        },
        { type: 'boolean', value: true },
        { type: 'symbol' },
      ]),
    ).toBe('{id: 7, name: "x", …} [1] null undefined 5n Error: no true symbol');
    expect(consoleText([])).toBe('');
  });

  it('maps console types to levels and locations to 1-based lines', () => {
    expect(['error', 'assert', 'warning', 'debug', 'trace', 'log', 'table'].map(levelOf)).toEqual([
      'error',
      'error',
      'warn',
      'debug',
      'debug',
      'info',
      'info',
    ]);
    expect(locationOf({ callFrames: [frame] })).toEqual({
      url: 'file:///app/renderer.js',
      line: 10,
      column: 5,
      stack: 'at save (file:///app/renderer.js:10:5)',
    });
    // A DevTools extension's console hook and a dependency's wrapper are passed over.
    const wrapped = locationOf({
      callFrames: [
        { ...frame, url: 'chrome-extension://abc/installHook.js', lineNumber: 0, columnNumber: 9 },
        { ...frame, url: 'file:///app/node_modules/reporter/console.js', lineNumber: 35, columnNumber: 0 },
        frame,
      ],
    });
    expect(wrapped).toMatchObject({ url: 'file:///app/renderer.js', line: 10, column: 5 });
    // Only the runtime's own frames: the first one that has a script.
    expect(
      locationOf({ callFrames: [{ ...frame, url: 'node:electron/js2c/renderer_init', lineNumber: 1 }] }),
    ).toMatchObject({ url: 'node:electron/js2c/renderer_init', line: 2 });
    expect(locationOf({ callFrames: [{ ...frame, url: '', functionName: '' }] })).toEqual({
      stack: 'at <anonymous> (:10:5)',
    });
    expect(locationOf(undefined)).toEqual({});
  });
});

describe('ConsoleCollector', () => {
  it('records console calls and exceptions of the page itself, with stacks only where they help', () => {
    const { book, page } = setup();
    page.emit(consoleEvent('log', [str('hello')], 10));
    page.emit(consoleEvent('warning', [str('careful')], 11));
    page.emit(consoleEvent('clear', [], 12));
    page.emit({ ...consoleEvent('error', [str('from a frame')], 13), sessionId: 'child' });
    page.emit({
      method: 'Runtime.exceptionThrown',
      params: {
        timestamp: 14,
        exceptionDetails: {
          text: 'Uncaught',
          url: 'file:///app/renderer.js',
          lineNumber: 2,
          columnNumber: 0,
          exception: {
            type: 'object',
            subtype: 'error',
            description: 'TypeError: x is undefined\n    at a (file:///app/renderer.js:3:1)',
          },
        },
      },
    });
    page.emit({
      method: 'Runtime.exceptionThrown',
      params: {
        timestamp: 15,
        exceptionDetails: { text: 'Script error.', stackTrace: { callFrames: [frame] } },
      },
    });
    page.emit({ method: 'Runtime.consoleAPICalled', params: { nonsense: true } });
    const { items } = book.query();
    expect(items.map(({ level, text, line, stack }) => [level, text, line, stack])).toEqual([
      ['info', 'hello', 10, undefined],
      ['warn', 'careful', 10, 'at save (file:///app/renderer.js:10:5)'],
      ['error', 'Uncaught TypeError: x is undefined', 3, 'at a (file:///app/renderer.js:3:1)'],
      ['error', 'Script error.', undefined, 'at save (file:///app/renderer.js:10:5)'],
    ]);
    expect(items[0]).toMatchObject({
      source: 'renderer',
      target: 'wc1',
      ts: 10,
      url: 'file:///app/renderer.js',
    });
    expect(items[3]?.url).toBe('file:///app/renderer.js');
    // The column lets a stackless exception in minified code be mapped.
    expect(items[2]?.column).toBe(1);
  });

  it('enables Runtime only when activated, on every page, new and re-attached ones too', async () => {
    const { collector, page } = setup();
    expect(page.calls).toEqual([]);
    expect(await collector.activate()).toBe(true);
    expect(await collector.activate()).toBe(false);
    expect(page.calls).toEqual([{ method: 'Runtime.enable', params: undefined, posted: false }]);
    const later = new FakeCdpTransport();
    collector.watch('wc2', later);
    expect(later.calls).toEqual([{ method: 'Runtime.enable', params: undefined, posted: true }]);
    page.reattach();
    expect(page.calls.at(-1)).toEqual({ method: 'Runtime.enable', params: undefined, posted: true });
    const detached = new FakeCdpTransport();
    detached.attached = false;
    collector.watch('wc3', detached);
    expect(detached.calls).toEqual([]);
  });

  it('skips what a fresh CDP session replays, each message as often as it was recorded', () => {
    const { book, page } = setup();
    page.emit(consoleEvent('log', [str('same')], 10));
    page.emit(consoleEvent('log', [str('same')], 10));
    page.emit(consoleEvent('log', [str('two')], 10));
    page.reattach();
    page.emit(consoleEvent('log', [str('same')], 10));
    page.emit(consoleEvent('log', [str('same')], 10));
    page.emit(consoleEvent('log', [str('two')], 10));
    page.emit(consoleEvent('log', [str('new, same time')], 10));
    page.emit(consoleEvent('log', [str('four')], 11));
    // The replay is over: a repeat is a new message again.
    page.emit(consoleEvent('log', [str('two')], 10));
    expect(book.query().items.map((entry) => entry.text)).toEqual([
      'same',
      'same',
      'two',
      'new, same time',
      'four',
      'two',
    ]);
  });

  it('keeps identical messages without a re-attach, also when the clock goes back', () => {
    const { book, page } = setup();
    for (const timestamp of [10, 10, 5]) page.emit(consoleEvent('error', [str('failed')], timestamp));
    expect(book.query().items).toHaveLength(3);
  });

  it('describes a thrown value that is not an Error', () => {
    const { book, page } = setup();
    page.emit({
      method: 'Runtime.exceptionThrown',
      params: {
        timestamp: 1,
        exceptionDetails: {
          text: 'Uncaught (in promise)',
          exception: { type: 'string', value: 'token expired' },
        },
      },
    });
    page.emit({
      method: 'Runtime.exceptionThrown',
      params: { timestamp: 2, exceptionDetails: { text: 'Uncaught' } },
    });
    expect(book.query().items.map((entry) => entry.text)).toEqual([
      'Uncaught (in promise) token expired',
      'Uncaught',
    ]);
  });

  it('lets a concurrent query wait for the same start', async () => {
    const { collector, page } = setup();
    const [first, second] = await Promise.all([collector.activate(), collector.activate()]);
    expect([first, second]).toEqual([true, false]);
    expect(page.calls.filter((call) => call.method === 'Runtime.enable')).toHaveLength(1);
  });

  it('stops listening to a page that is gone, and forgets what it saw', () => {
    const { book, page, watching, collector } = setup();
    page.emit(consoleEvent('log', [str('a')], 10));
    watching.dispose();
    page.emit(consoleEvent('log', [str('b')], 11));
    collector.watch('wc1', page);
    page.emit(consoleEvent('log', [str('a')], 10));
    expect(book.query().items.map((entry) => entry.text)).toEqual(['a', 'a']);
  });
});

describe('LogBook', () => {
  it('filters by level, source, page and text, pages with a cursor, and clips long text', () => {
    const book = new LogBook({ now: () => 42 });
    book.add({ source: 'main', level: 'debug', text: 'boot' });
    book.add({
      source: 'renderer',
      level: 'error',
      text: 'Failed',
      target: 'wc1',
      url: 'file:///Index.html',
    });
    book.add({
      source: 'custom',
      level: 'warn',
      text: 'x'.repeat(MAX_LOG_TEXT + 5),
      stack: 'y'.repeat(5_000),
    });
    book.add({ source: 'process', level: 'error', text: 'load', url: 'https://h/x?access_token=abc' });
    expect(book.query({ minLevel: 'warn' }).items.map((entry) => entry.seq)).toEqual([2, 3, 4]);
    expect(book.query({ source: 'main' }).items[0]).toMatchObject({ ts: 42, text: 'boot' });
    expect(book.query({ targetId: 'wc1' }).items).toHaveLength(1);
    expect(book.query({ contains: 'index' }).items).toHaveLength(1);
    expect(book.query({ contains: 'FAILED' }).items).toHaveLength(1);
    const clipped = book.query({ source: 'custom' }).items[0];
    expect(clipped?.text).toHaveLength(MAX_LOG_TEXT);
    expect(clipped?.stack?.endsWith('…')).toBe(true);
    expect(book.query({ limit: 1 })).toMatchObject({ nextSeq: 1 });
    expect(book.query({ since: 1, minLevel: 'error' })).toMatchObject({ nextSeq: 4 });
    expect(book.lastSeq()).toBe(4);
    expect(book.query({ source: 'process' }).items[0]?.url).toBe('https://h/x?access_token=%5Bredacted%5D');
  });

  it('evicts the oldest entries within its byte budget and reports them as dropped', () => {
    const book = new LogBook({ capacityBytes: 1_000 });
    for (let index = 0; index < 50; index++)
      book.add({ source: 'main', level: 'info', text: `line ${index}` });
    const page = book.query();
    expect(page.dropped).toBeGreaterThan(0);
    expect(page.items.at(-1)?.text).toBe('line 49');
  });

  it('caps a page’s console rate, counting what it left out and saying so when messages resume', async () => {
    const book = new LogBook({ now: () => 5 });
    const clock = new FakeClock();
    const collector = new ConsoleCollector(book, clock);
    const page = new FakeCdpTransport().handle('Runtime.enable', () => ({}));
    collector.watch('wc1', page);
    await collector.activate();
    for (let index = 0; index < CONSOLE_BURST + 500; index++)
      page.emit(consoleEvent('log', [str(`m${index}`)], index));
    page.emit({
      method: 'Runtime.exceptionThrown',
      params: { timestamp: 1, exceptionDetails: { text: 'Uncaught boom' } },
    });
    const end = { since: 0, nextSeq: book.lastSeq() };
    expect(collector.cappedIn(end)).toBe(500);
    expect(collector.cappedIn(end, 'wc1')).toBe(500);
    // Scoped to what a query covers: another page, or a range before the flood, saw none.
    expect(collector.cappedIn(end, 'wc2')).toBe(0);
    expect(collector.cappedIn({ since: 0, nextSeq: 10 })).toBe(0);
    clock.advance(1_000);
    page.emit(consoleEvent('log', [str('after')], 99_999));
    const texts = book.query({ limit: 500, since: CONSOLE_BURST - 2 }).items.map((entry) => entry.text);
    expect(texts).toEqual([
      `m${CONSOLE_BURST - 2}`,
      `m${CONSOLE_BURST - 1}`,
      'Uncaught boom',
      `Console flood: 500 message(s) from this page were not recorded (over ${CONSOLE_RATE_PER_SECOND}/s)`,
      'after',
    ]);
  });

  it('writes a flood still going on before a read, so the read counts its gap once', async () => {
    const book = new LogBook({ now: () => 5 });
    const collector = new ConsoleCollector(book, new FakeClock());
    const page = new FakeCdpTransport().handle('Runtime.enable', () => ({}));
    collector.watch('wc1', page);
    await collector.activate();
    for (let index = 0; index < CONSOLE_BURST + 300; index++)
      page.emit(consoleEvent('log', [str(`m${index}`)], index));
    // Nothing follows the dropped messages yet: the gap has no record after it.
    expect(collector.cappedIn({ since: 0, nextSeq: book.lastSeq() })).toBe(0);
    collector.flush();
    const all = { since: 0, nextSeq: book.lastSeq() };
    expect(collector.cappedIn(all)).toBe(300);
    expect(book.query({ since: CONSOLE_BURST }).items.at(-1)?.text).toMatch(/^Console flood: 300 message/);
    collector.flush();
    expect(book.lastSeq()).toBe(all.nextSeq);
    expect(collector.cappedIn({ since: all.nextSeq, nextSeq: all.nextSeq })).toBe(0);
  });
});
