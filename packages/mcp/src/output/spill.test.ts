import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileSpill, SPILL_TTL_MS } from './spill.js';

const posix = process.platform !== 'win32';
let root: string;

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'eab-spill-test-'));
  return root;
}

describe('FileSpill', () => {
  it('writes each output to a new owner-only file in a private directory', () => {
    const directory = join(freshRoot(), 'spill');
    const spill = new FileSpill(directory);
    const first = spill.write('one');
    const second = spill.write('two');
    expect(first).not.toBe(second);
    expect(readFileSync(first, 'utf8')).toBe('one');
    if (posix) {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(first).mode & 0o777).toBe(0o600);
    }
  });

  it('removes its own files older than the TTL and leaves other files alone', () => {
    const directory = join(freshRoot(), 'spill');
    let now = Date.now();
    const spill = new FileSpill(directory, () => now);
    const old = spill.write('old');
    const past = (now - SPILL_TTL_MS - 60_000) / 1000;
    utimesSync(old, past, past);
    writeFileSync(join(directory, 'notes.txt'), 'keep');
    now += 1;
    spill.write('new');
    expect(readdirSync(directory).filter((name) => name.startsWith('output-'))).toHaveLength(1);
    expect(readdirSync(directory)).toContain('notes.txt');
  });

  it.runIf(posix)('refuses a symlinked directory and tightens loose permissions', () => {
    const base = freshRoot();
    const real = join(base, 'real');
    mkdirSync(real, { mode: 0o755 });
    const link = join(base, 'link');
    symlinkSync(real, link);
    expect(() => new FileSpill(link).write('x')).toThrow(/not a private directory/);
    new FileSpill(real).write('x');
    expect(statSync(real).mode & 0o777).toBe(0o700);
  });
});
