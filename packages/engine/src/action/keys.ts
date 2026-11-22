import { BridgeError } from '@eab/core';

/** A key as CDP `Input.dispatchKeyEvent` wants it. */
export interface KeyDefinition {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  /** Text the key inserts when pressed without command modifiers. */
  readonly text?: string;
}

/** CDP modifier bit for Shift (the only modifier that still produces text). */
export const SHIFT_BIT = 8;

export interface ModifierKey {
  readonly bit: number;
  readonly definition: KeyDefinition;
}

/** Modifier names accepted in chords, with their CDP bit and key definition. */
export const MODIFIERS: Readonly<Record<string, ModifierKey>> = {
  Alt: { bit: 1, definition: { key: 'Alt', code: 'AltLeft', keyCode: 18 } },
  Control: { bit: 2, definition: { key: 'Control', code: 'ControlLeft', keyCode: 17 } },
  Meta: { bit: 4, definition: { key: 'Meta', code: 'MetaLeft', keyCode: 91 } },
  Shift: { bit: 8, definition: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 } },
};

const ALIASES: Readonly<Record<string, string>> = {
  Ctrl: 'Control',
  Cmd: 'Meta',
  Command: 'Meta',
  Option: 'Alt',
  Esc: 'Escape',
  Return: 'Enter',
  Del: 'Delete',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
};

const NAMED: Readonly<Record<string, KeyDefinition>> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

/** A parsed chord such as `Control+Shift+K`: modifiers (in order) and the main key. */
export interface Chord {
  readonly modifiers: readonly ModifierKey[];
  readonly key: KeyDefinition;
  /** CDP modifier bitmask. */
  readonly mask: number;
}

/** Parse `Enter`, `a`, `Control+S`, `Meta+Shift+P`, `F5`… Throws `INVALID_PARAMS` for unknown keys. */
export function parseChord(chord: string): Chord {
  const trimmed = chord.trim();
  // `+` is a key too: `+`, `Control++`.
  const plusKey = trimmed === '+' || trimmed.endsWith('++');
  const parts = (plusKey ? trimmed.slice(0, -1) : trimmed)
    .split('+')
    .map((part) => ALIASES[part.trim()] ?? part.trim());
  const last = plusKey ? '+' : parts.pop();
  if (last === undefined || last === '') throw invalid(chord, 'is empty');
  const modifiers = parts
    .filter((part) => part !== '')
    .map((name) => {
      const modifier = MODIFIERS[name];
      if (!modifier) throw invalid(chord, `has an unknown modifier "${name}"`);
      return modifier;
    });
  const mask = modifiers.reduce((bits, modifier) => bits | modifier.bit, 0);
  return { modifiers, key: shifted(keyDefinition(last, chord), mask), mask };
}

/** Shift turns a letter into its capital (other shifted symbols depend on the keyboard layout). */
function shifted(key: KeyDefinition, mask: number): KeyDefinition {
  if ((mask & SHIFT_BIT) === 0 || key.text === undefined || !/^[a-z]$/.test(key.text)) return key;
  const upper = key.text.toUpperCase();
  return { ...key, key: upper, text: upper };
}

function keyDefinition(name: string, chord: string): KeyDefinition {
  const named = NAMED[name] ?? MODIFIERS[name]?.definition;
  if (named) return named;
  const fn = /^F([1-9]|1[0-2])$/.exec(name);
  if (fn) return { key: name, code: name, keyCode: 111 + Number(fn[1]) };
  if (Array.from(name).length !== 1) throw invalid(chord, `has an unknown key "${name}"`);
  const upper = name.toUpperCase();
  if (/^[A-Z]$/.test(upper))
    return { key: name, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: name };
  if (/^[0-9]$/.test(name))
    return { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0), text: name };
  return { key: name, code: '', keyCode: 0, text: name };
}

function invalid(chord: string, problem: string): BridgeError {
  return new BridgeError('INVALID_PARAMS', `key ${JSON.stringify(chord)} ${problem}`, {
    hint: 'Use names like Enter, Tab, Escape, ArrowDown, F5, single characters, and modifiers Control/Alt/Shift/Meta joined with "+".',
  });
}
