import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROTOCOL_VERSION, type Handshake } from '@electron-agent-bridge/core';
import { describe, expect, it } from 'vitest';

import { listInstances, readHandshake } from './discovery.js';

function handshake(pid: number, startedAt: number): Handshake {
  return {
    schema: 1,
    protocolVersion: PROTOCOL_VERSION,
    pid,
    startedAt,
    endpoint: `pipe-${pid}`,
    token: 't',
    app: { name: 'a', version: '1' },
    electron: '45.0.0',
  };
}

/** Handshakes are written owner-only by the runtime; discovery rejects anything looser on POSIX. */
const PRIVATE = { mode: 0o600 };

describe('discovery', () => {
  it('lists live instances newest first and skips dead, malformed and unrelated files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'eab-'));
    // The test runner's own pid and its parent are alive; 2^30 is not.
    writeFileSync(join(directory, `${process.pid}.json`), JSON.stringify(handshake(process.pid, 1)), PRIVATE);
    writeFileSync(
      join(directory, `${process.ppid}.json`),
      JSON.stringify(handshake(process.ppid, 2)),
      PRIVATE,
    );
    writeFileSync(join(directory, `${2 ** 30}.json`), JSON.stringify(handshake(2 ** 30, 3)), PRIVATE);
    writeFileSync(join(directory, '42.json'), '{"half":', PRIVATE);
    // A handshake whose file name and pid disagree is not genuine.
    writeFileSync(join(directory, '1.json'), JSON.stringify(handshake(process.pid, 9)), PRIVATE);
    writeFileSync(join(directory, 'notes.txt'), 'x', PRIVATE);
    expect(listInstances(directory).map((instance) => instance.handshake.pid)).toEqual([
      process.ppid,
      process.pid,
    ]);
  });

  it('returns nothing for a missing directory', () => {
    expect(listInstances(join(tmpdir(), 'eab-does-not-exist-'))).toEqual([]);
  });

  it('reports missing and malformed handshakes with codes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'eab-'));
    writeFileSync(join(directory, 'bad.json'), '{}', PRIVATE);
    expect(() => readHandshake(join(directory, 'none.json'))).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
    expect(() => readHandshake(join(directory, 'bad.json'))).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMS' }),
    );
  });

  it.skipIf(process.platform === 'win32')('ignores handshakes other users could have written', () => {
    const directory = mkdtempSync(join(tmpdir(), 'eab-'));
    writeFileSync(join(directory, `${process.pid}.json`), JSON.stringify(handshake(process.pid, 1)), {
      mode: 0o644,
    });
    expect(listInstances(directory)).toEqual([]);
    expect(() => readHandshake(join(directory, `${process.pid}.json`))).toThrow(
      expect.objectContaining({ code: 'UNAUTHORIZED' }),
    );
  });
});
