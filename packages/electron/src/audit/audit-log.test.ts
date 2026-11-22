import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileAuditLog, NO_AUDIT } from './audit-log.js';

const entry = { ts: 1, method: 'targets.list', ok: true, ms: 1.5, session: 's1', client: 'c' };

describe('FileAuditLog', () => {
  it('appends one JSON line per entry, owner-only', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'eab-')), 'audit.jsonl');
    const log = new FileAuditLog({ path });
    log.record(entry);
    log.record({ ...entry, ok: false, code: 'TIMEOUT' });
    log.close();
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      entry,
      { ...entry, ok: false, code: 'TIMEOUT' },
    ]);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('rotates once past the size cap, keeping at most two files', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'eab-')), 'audit.jsonl');
    const log = new FileAuditLog({ path, maxBytes: 300 });
    for (let index = 0; index < 20; index++) log.record({ ...entry, ts: index });
    log.close();
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(statSync(path).size).toBeLessThanOrEqual(300);
    expect(statSync(`${path}.1`).size).toBeLessThanOrEqual(300);
  });

  it('continues an existing file and never throws when it cannot write', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'eab-')), 'audit.jsonl');
    new FileAuditLog({ path }).record(entry);
    const reopened = new FileAuditLog({ path });
    reopened.record(entry);
    reopened.close();
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    const unwritable = new FileAuditLog({ path: join(path, 'not-a-dir', 'audit.jsonl') });
    expect(() => {
      unwritable.record(entry);
      unwritable.close();
      reopened.record(entry);
    }).not.toThrow();
    expect(() => {
      NO_AUDIT.record(entry);
      NO_AUDIT.close();
    }).not.toThrow();
  });
});
