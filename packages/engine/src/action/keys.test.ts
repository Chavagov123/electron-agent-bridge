import { describe, expect, it } from 'vitest';

import { parseChord } from './keys.js';

const keyOf = (chord: string) => parseChord(chord).key;

describe('parseChord', () => {
  it('parses named keys, letters, digits, symbols and function keys', () => {
    expect(keyOf('Enter')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
    expect(keyOf('Esc').key).toBe('Escape');
    expect(keyOf('a')).toEqual({ key: 'a', code: 'KeyA', keyCode: 65, text: 'a' });
    expect(keyOf('7')).toEqual({ key: '7', code: 'Digit7', keyCode: 55, text: '7' });
    expect(keyOf('/')).toEqual({ key: '/', code: '', keyCode: 0, text: '/' });
    expect(keyOf('F12')).toEqual({ key: 'F12', code: 'F12', keyCode: 123 });
    expect(keyOf('Shift').code).toBe('ShiftLeft');
  });

  it('collects modifiers in order with their bitmask, accepting aliases', () => {
    const chord = parseChord('Ctrl+Shift+K');
    expect(chord.modifiers.map((modifier) => modifier.definition.key)).toEqual(['Control', 'Shift']);
    expect(chord.mask).toBe(2 | 8);
    expect(parseChord('Cmd+Option+P').mask).toBe(4 | 1);
  });

  it('presses + itself, alone or with modifiers', () => {
    expect(keyOf('+').key).toBe('+');
    const zoom = parseChord('Control++');
    expect(zoom.key.key).toBe('+');
    expect(zoom.mask).toBe(2);
  });

  it('capitalises letters typed with Shift', () => {
    expect(keyOf('Shift+a')).toMatchObject({ key: 'A', text: 'A', code: 'KeyA' });
    expect(keyOf('Shift+1')).toMatchObject({ key: '1', text: '1' });
    expect(keyOf('Shift+Tab').key).toBe('Tab');
  });

  it('rejects empty chords, unknown keys and unknown modifiers with a hint', () => {
    for (const [chord, problem] of [
      ['', 'is empty'],
      ['Control+', 'is empty'],
      ['Hyper+Q', 'unknown modifier "Hyper"'],
      ['Banana', 'unknown key "Banana"'],
    ] as const) {
      expect(() => parseChord(chord)).toThrow(
        expect.objectContaining({
          code: 'INVALID_PARAMS',
          message: expect.stringContaining(problem) as unknown,
          hint: expect.stringContaining('Enter, Tab') as unknown,
        }),
      );
    }
  });
});
