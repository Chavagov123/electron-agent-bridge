import { describe, expect, it } from 'vitest';

import type { LocationMapper, StackMapper } from '../ports/stack-mapper.js';
import { mapEntries, mapEntry } from './map-stack.js';

const mapper: LocationMapper = {
  map: (url, line, column) =>
    url.endsWith('bundle.js') ? { url: '/src/app.ts', line: line * 10, column: column + 1 } : undefined,
};

describe('mapEntry', () => {
  it('rewrites mappable frames and the top location, and marks the entry mapped', () => {
    const entry = {
      source: 'renderer' as const,
      level: 'error' as const,
      text: 'Error: x',
      url: 'file:///app/bundle.js',
      line: 2,
      stack: [
        '    at save (file:///app/bundle.js:2:15)',
        '    at file:///app/bundle.js:7:1',
        '    at other (file:///app/vendor.js:1:1)',
        'onClick@file:///app/bundle.js:3:4',
        'not a frame',
      ].join('\n'),
    };
    expect(mapEntry(entry, mapper)).toEqual({
      ...entry,
      url: '/src/app.ts',
      line: 20,
      column: 16,
      mapped: true,
      stack: [
        '    at save (/src/app.ts:20:16)',
        '    at /src/app.ts:70:2',
        '    at other (file:///app/vendor.js:1:1)',
        'onClick@/src/app.ts:30:5',
        'not a frame',
      ].join('\n'),
    });
  });

  it('returns entries it cannot map unchanged, and survives a throwing mapper', () => {
    const entry = {
      source: 'main' as const,
      level: 'info' as const,
      text: 'hi',
      stack: '    at x (/a/vendor.js:1:1)',
    };
    expect(mapEntry(entry, mapper)).toBe(entry);
    const throwing: LocationMapper = {
      map: () => {
        throw new Error('disk');
      },
    };
    expect(mapEntry({ ...entry, stack: '    at y (/a/bundle.js:1:1)' }, throwing)).not.toHaveProperty(
      'mapped',
    );
  });

  it('keeps the top location as recorded when no stack frame is at that place', () => {
    const entry = {
      source: 'renderer' as const,
      level: 'error' as const,
      text: 'x',
      url: 'file:///app/bundle.js',
      line: 1,
      stack: '    at f (file:///app/bundle.js:7:3)',
    };
    expect(mapEntry(entry, mapper)).toMatchObject({ url: 'file:///app/bundle.js', line: 1, mapped: true });
  });

  it('attributes a message to the app code that called a console wrapper', () => {
    const vendor: LocationMapper = {
      map: (url, line) => {
        if (!url.endsWith('bundle.js')) return undefined;
        return line === 1
          ? { url: 'webpack://app/node_modules/@reporter/console.js', line: 36, column: 1 }
          : { url: 'webpack://app/src/orders.tsx', line: 12, column: 7 };
      },
    };
    const entry = {
      source: 'renderer' as const,
      level: 'warn' as const,
      text: 'careful',
      url: 'file:///app/bundle.js',
      line: 1,
      column: 40,
      stack: [
        '    at overrideMethod (chrome-extension://abc/installHook.js:1:9)',
        '    at <anonymous> (file:///app/bundle.js:1:40)',
        '    at save (file:///app/bundle.js:9:3)',
      ].join('\n'),
    };
    expect(mapEntry(entry, vendor)).toMatchObject({
      url: 'webpack://app/src/orders.tsx',
      line: 12,
      column: 7,
      mapped: true,
    });
  });

  it('maps a location without a stack by its column, and leaves one without a column alone', () => {
    const entry = {
      source: 'renderer' as const,
      level: 'info' as const,
      text: 'hi',
      url: 'file:///app/bundle.js',
      line: 3,
      column: 8,
    };
    expect(mapEntry(entry, mapper)).toEqual({
      ...entry,
      url: '/src/app.ts',
      line: 30,
      column: 9,
      mapped: true,
    });
    const noColumn = { source: entry.source, level: entry.level, text: entry.text, url: entry.url, line: 3 };
    expect(mapEntry(noColumn, mapper)).toBe(noColumn);
  });
});

describe('mapEntry with frames in the text', () => {
  it('maps a React component stack and places a warning there when its stack is all dependencies', () => {
    const entry = {
      source: 'renderer' as const,
      level: 'error' as const,
      text: [
        'Warning: React does not recognize the `x` prop. Error Component Stack',
        '    at button (<anonymous>)',
        '    at Card (file:///app/bundle.js:5:9)',
        '    at file:///app/bundle.js:6:1',
      ].join('\n'),
      url: 'file:///app/node_modules/react-dom.js',
      line: 1,
      stack: '    at printWarning (file:///app/node_modules/react-dom.js:1:1)',
    };
    expect(mapEntry(entry, mapper)).toEqual({
      ...entry,
      text: [
        'Warning: React does not recognize the `x` prop. Error Component Stack',
        '    at button (<anonymous>)',
        '    at Card (/src/app.ts:50:10)',
        '    at /src/app.ts:60:2',
      ].join('\n'),
      url: '/src/app.ts',
      line: 50,
      column: 10,
      mapped: true,
    });
    const stackless = { source: entry.source, level: entry.level, text: entry.text };
    expect(mapEntry(stackless, mapper)).toMatchObject({ url: '/src/app.ts', line: 50, mapped: true });
    const plain = { ...stackless, text: 'one line' };
    expect(mapEntry(plain, mapper)).toBe(plain);
  });
});

describe('mapEntries', () => {
  const entries: {
    source: 'main';
    level: 'error' | 'info';
    text: string;
    url?: string;
    line?: number;
    column?: number;
    stack?: string;
    mapped?: boolean;
  }[] = [
    {
      source: 'main' as const,
      level: 'error' as const,
      text: 'Error: x',
      url: '/app/bundle.js',
      line: 2,
      stack: '    at a (/app/bundle.js:2:5)\n    at b (/app/bundle.js:2:5)',
    },
    {
      source: 'main' as const,
      level: 'info' as const,
      text: 'hi',
      url: '/app/bundle.js',
      line: 4,
      column: 1,
    },
    { source: 'main' as const, level: 'info' as const, text: 'plain' },
  ];

  it('resolves every location of a page in one batched call, each once', async () => {
    const asked: string[][] = [];
    const batched: StackMapper = {
      mapAll: (locations) => {
        asked.push(locations.map(({ url, line, column }) => `${url}:${String(line)}:${String(column)}`));
        return Promise.resolve(locations.map(({ url, line, column }) => mapper.map(url, line, column)));
      },
    };
    const result = await mapEntries(entries, batched);
    expect(asked).toEqual([['/app/bundle.js:2:5', '/app/bundle.js:4:1']]);
    expect(result.late).toBe(false);
    expect(result.items.map((entry) => [entry.url, entry.line, entry.mapped])).toEqual([
      ['/src/app.ts', 20, true],
      ['/src/app.ts', 40, true],
      [undefined, undefined, undefined],
    ]);
    const plain = entries.slice(2);
    const none = await mapEntries(plain, batched);
    expect(none.items[0]).toBe(plain[0]);
    expect(asked).toHaveLength(1);
  });

  it('returns the entries as recorded when the mapper is late or fails', async () => {
    const slow: StackMapper = { mapAll: () => new Promise(() => undefined) };
    const failing: StackMapper = { mapAll: () => Promise.reject(new Error('worker gone')) };
    const late = await mapEntries(entries, slow, 5);
    expect(late).toEqual({ items: entries, late: true });
    expect(await mapEntries(entries, failing)).toEqual({ items: entries, late: false });
  });
});
