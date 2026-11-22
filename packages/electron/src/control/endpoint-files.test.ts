import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROTOCOL_VERSION, type Handshake } from '@eab/core';
import { describe, expect, it } from 'vitest';

import {
  AUDIT_RETENTION_MS,
  assertPrivateDir,
  ensureEndpointDir,
  isProcessAlive,
  sweepStaleEndpoints,
} from './endpoint-dir.js';
import { HandshakeFile } from './handshake-file.js';

const posix = process.platform !== 'win32';

const handshake: Handshake = {
  schema: 1,
  protocolVersion: PROTOCOL_VERSION,
  pid: process.pid,
  startedAt: 1,
  endpoint: 'pipe',
  token: 'token',
  app: { name: 'a', version: '1' },
  electron: '45.0.0',
};

describe('HandshakeFile', () => {
  it('writes atomically with owner-only permissions and removes once', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'eab-')), '1.json');
    const file = new HandshakeFile(path);
    file.write(handshake);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(handshake);
    if (posix) expect(statSync(path).mode & 0o777).toBe(0o600);
    file.remove();
    expect(existsSync(path)).toBe(false);
    expect(() => {
      file.remove();
    }).not.toThrow();
  });

  it('updates the details while written, and never recreates a removed file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'eab-')), '1.json');
    const file = new HandshakeFile(path);
    file.write(handshake);
    const named = { ...handshake, app: { name: 'MyApp', version: '2.0.0' } };
    file.update(named);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(named);
    file.remove();
    file.update(handshake);
    expect(existsSync(path)).toBe(false);
  });
});

describe('endpoint directory', () => {
  it('creates the directory owner-only and tightens loose permissions', () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'eab-')), 'nested');
    ensureEndpointDir(directory);
    expect(statSync(directory).isDirectory()).toBe(true);
    if (posix) expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it('sweeps files of dead processes but keeps live ones and unrelated files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'eab-'));
    const names = ['111.json', 'eab-111-abc.sock', '222.json', `${process.pid}.json`, 'notes.txt'];
    for (const name of names) writeFileSync(join(directory, name), '');
    sweepStaleEndpoints(directory, (pid) => pid === 222);
    expect(names.filter((name) => existsSync(join(directory, name)))).toEqual([
      '222.json',
      `${process.pid}.json`,
      'notes.txt',
    ]);
  });

  it('keeps audit logs of exited processes for the retention period, then removes them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'eab-'));
    const names = ['audit-111.jsonl', 'audit-111.jsonl.1', 'audit-222.jsonl'];
    for (const name of names) writeFileSync(join(directory, name), '');
    sweepStaleEndpoints(directory, (pid) => pid === 222);
    expect(names.filter((name) => existsSync(join(directory, name)))).toEqual(names);
    sweepStaleEndpoints(directory, (pid) => pid === 222, Date.now() + AUDIT_RETENTION_MS + 1_000);
    expect(names.filter((name) => existsSync(join(directory, name)))).toEqual(['audit-222.jsonl']);
  });

  it('accepts a private custom directory and refuses a missing one', () => {
    const directory = mkdtempSync(join(tmpdir(), 'eab-'));
    expect(() => {
      assertPrivateDir(directory);
    }).not.toThrow();
    if (posix) {
      chmodSync(directory, 0o777);
      expect(() => {
        assertPrivateDir(directory);
      }).toThrow(expect.objectContaining({ code: 'UNSUPPORTED' }));
      expect(() => {
        assertPrivateDir(join(directory, 'missing'));
      }).toThrow();
    }
  });

  it('never writes a handshake through a planted temp file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'eab-')), '1.json');
    writeFileSync(`${path}.${process.pid}.tmp`, 'planted');
    new HandshakeFile(path).write(handshake);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(handshake);
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });

  it('detects the current process as alive and a bogus pid as dead', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 30)).toBe(false);
  });
});
