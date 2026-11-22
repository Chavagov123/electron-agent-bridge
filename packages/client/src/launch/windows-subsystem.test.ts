import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { isConsoleProgram } from './windows-subsystem.js';

const work = mkdtempSync(join(tmpdir(), 'eab-subsystem-'));
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** A minimal PE header: MZ stub pointing at a PE signature, with the given subsystem. */
function executable(name: string, subsystem: number): string {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ', 0, 'latin1');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'latin1');
  bytes.writeUInt16LE(subsystem, 0x80 + 92);
  const path = join(work, name);
  writeFileSync(path, bytes);
  return path;
}

describe('isConsoleProgram', () => {
  it('tells console programs from GUI programs by the PE subsystem', () => {
    expect(isConsoleProgram(executable('console.exe', 3))).toBe(true);
    expect(isConsoleProgram(executable('gui.exe', 2))).toBe(false);
  });

  it('treats readable non-PE files as GUI and unreadable ones as console programs', () => {
    const script = join(work, 'app.sh');
    writeFileSync(script, '#!/bin/sh\n');
    expect(isConsoleProgram(script)).toBe(false);
    // Unreadable (a bare name found through PATH): hidden, as console programs are.
    expect(isConsoleProgram(join(work, 'missing.exe'))).toBe(true);
  });

  it.runIf(process.platform === 'win32')('knows Node itself is a console program', () => {
    expect(isConsoleProgram(process.execPath)).toBe(true);
  });
});
