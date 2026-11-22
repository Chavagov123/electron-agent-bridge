import { describe, expect, it } from 'vitest';

import { BridgeError } from '../errors/bridge-error.js';
import { LineDecoder, encodeLine } from './ndjson.js';

describe('encodeLine', () => {
  it('produces exactly one line even when strings contain newlines', () => {
    const line = encodeLine({ text: 'a\nb' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({ text: 'a\nb' });
  });
});

describe('LineDecoder', () => {
  it('reassembles lines split across chunks and skips blank lines', () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"a":')).toEqual([]);
    expect(decoder.push('1}\n\n{"b"')).toEqual(['{"a":1}']);
    expect(decoder.push(':2}\n')).toEqual(['{"b":2}']);
  });

  it('handles many lines per chunk and a line spread over many chunks', () => {
    const decoder = new LineDecoder();
    expect(decoder.push('1\n2\n3')).toEqual(['1', '2']);
    for (const piece of ['4', '5', '6']) expect(decoder.push(piece)).toEqual([]);
    expect(decoder.push('\n')).toEqual(['3456']);
  });

  it('rejects a line that grows past the cap across chunks, then recovers', () => {
    const decoder = new LineDecoder(8);
    decoder.push('01234');
    expect(() => decoder.push('56789')).toThrow(BridgeError);
    expect(decoder.push('ok\n')).toEqual(['ok']);
  });

  it('rejects a line that grows past the cap without a newline', () => {
    const decoder = new LineDecoder(8);
    expect(() => decoder.push('0123456789')).toThrow(BridgeError);
  });

  it('rejects a complete line past the cap', () => {
    const decoder = new LineDecoder(8);
    try {
      decoder.push('0123456789\n');
      expect.unreachable();
    } catch (error) {
      expect((error as BridgeError).code).toBe('BUDGET_EXCEEDED');
    }
  });
});
