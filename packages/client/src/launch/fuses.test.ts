import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { asarOf, blockedStrategies, fuseFileOf, readFuses } from './fuses.js';

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
let directory: string | undefined;

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

/** A fake binary: padding, the sentinel at `offset`, then version 1 and the wire. */
function binary(wire: string, offset = 100): string {
  directory ??= mkdtempSync(join(tmpdir(), 'eab-fuses-'));
  const file = join(directory, `electron-${offset}`);
  const body = Buffer.concat([
    Buffer.alloc(offset, 0x41),
    Buffer.from(SENTINEL),
    Buffer.from([1, wire.length]),
    Buffer.from(wire, 'latin1'),
    Buffer.alloc(64),
  ]);
  writeFileSync(file, body);
  return file;
}

describe('readFuses', () => {
  it('decodes the fuse wire after the sentinel', async () => {
    const report = await readFuses(binary('1010r1001'));
    expect(report).toEqual({
      file: expect.stringContaining('electron-100') as unknown,
      wireVersion: 1,
      fuses: {
        RunAsNode: 'on',
        EnableCookieEncryption: 'off',
        EnableNodeOptionsEnvironmentVariable: 'on',
        EnableNodeCliInspectArguments: 'off',
        EnableEmbeddedAsarIntegrityValidation: 'removed',
        OnlyLoadAppFromAsar: 'on',
        LoadBrowserProcessSpecificV8Snapshot: 'off',
        GrantFileProtocolExtraPrivileges: 'off',
        WasmTrapHandlers: 'on',
      },
    });
    expect(blockedStrategies(report)).toEqual(['inspector']);
  });

  it('finds a sentinel across a chunk boundary and names fuses it does not know', async () => {
    const report = await readFuses(binary('0011111111', 4 * 1024 * 1024 - 10));
    expect(report?.fuses['EnableNodeOptionsEnvironmentVariable']).toBe('on');
    expect(report?.fuses['fuse9']).toBe('on');
    const both = await readFuses(binary('1100', 50));
    expect(blockedStrategies(both)).toEqual(['node-options', 'inspector']);
  });

  it('reports nothing for files without a wire, and missing files', async () => {
    directory = mkdtempSync(join(tmpdir(), 'eab-fuses-'));
    const plain = join(directory, 'plain');
    writeFileSync(plain, 'not electron');
    expect(await readFuses(plain)).toBeUndefined();
    expect(await readFuses(join(directory, 'missing'))).toBeUndefined();
    expect(blockedStrategies(undefined)).toEqual([]);
  });
});

describe('binary layout', () => {
  it('reads macOS fuses from the Electron Framework and finds app.asar next to the app', () => {
    expect(fuseFileOf('/Apps/My.app')).toMatch(
      /My\.app[\\/]Contents[\\/]Frameworks[\\/]Electron Framework\.framework[\\/]Electron Framework$/,
    );
    expect(fuseFileOf('/Apps/My.app/Contents/MacOS/My')).toMatch(/My\.app[\\/]Contents[\\/]Frameworks[\\/]/);
    expect(fuseFileOf('/opt/app/app')).toBe('/opt/app/app');
    expect(asarOf('/Apps/My.app/Contents/MacOS/My')).toMatch(
      /My\.app[\\/]Contents[\\/]Resources[\\/]app\.asar$/,
    );
    directory = mkdtempSync(join(tmpdir(), 'eab-fuses-'));
    mkdirSync(join(directory, 'resources'));
    expect(asarOf(join(directory, 'app.exe'))).toBe(join(directory, 'resources', 'app.asar'));
  });
});
