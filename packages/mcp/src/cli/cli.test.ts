import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocatorSchema } from '@eab/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { api, calls, fakeClient, handshake } from '../testing/mcp-harness.js';
import type { ClientApi } from '../session/session-manager.js';
import { parseCliArgs } from './args.js';
import { coerce } from './coerce.js';
import { runCli, type CliIo } from './run-cli.js';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, Uint8Array>();
  const sink: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    writeFile: (path, data) => files.set(path, data),
    now: () => 1700,
  };
  return { sink, out, err, files };
}

describe('parseCliArgs', () => {
  it('keeps values as strings, nests dotted keys, and reads flags and --json', () => {
    expect(
      parseCliArgs([
        'snapshot',
        '--depth',
        '3',
        '--changesOnly',
        '--root',
        'e5',
        '--locator.role',
        'button',
        '--json',
        '{"target":"main"}',
        '--pid',
        '42',
        '--observe',
        '--out',
        'a.png',
      ]),
    ).toEqual({
      command: 'snapshot',
      input: { target: 'main', depth: '3', changesOnly: true, root: 'e5', locator: { role: 'button' } },
      pid: 42,
      role: 'observer',
      out: 'a.png',
      help: false,
    });
  });

  it('keeps pid as input of the session command, and role as input of every tool', () => {
    expect(parseCliArgs(['find', '--role', 'button']).input).toEqual({ role: 'button' });
    expect(parseCliArgs(['session', '--action', 'connect', '--pid', '7']).input).toEqual({
      action: 'connect',
      pid: '7',
    });
  });

  it('rejects stray arguments and a non-object --json', () => {
    expect(() => parseCliArgs(['act', 'oops'])).toThrow(/unexpected argument "oops"/);
    expect(() => parseCliArgs(['act', '--json', '[1]'])).toThrow(/--json needs a JSON object/);
    expect(parseCliArgs(['--help']).help).toBe(true);
    expect(parseCliArgs([]).command).toBeUndefined();
  });
});

describe('coerce', () => {
  const schema = z.object({
    contains: z.string().optional(),
    depth: z.number().optional(),
    exact: z.boolean().optional(),
    values: z.array(z.string()).optional(),
    kind: z.enum(['a', 'b']).optional(),
    either: z.union([z.string(), z.number()]).optional(),
    locator: LocatorSchema.optional(),
    raw: z.unknown().optional(),
  });

  it('keeps strings where the schema takes strings and reads JSON elsewhere, nested too', () => {
    expect(
      coerce(schema, {
        contains: '404',
        depth: '3',
        exact: 'true',
        values: '["a","b"]',
        kind: 'a',
        either: '7',
        locator: { name: '2024', nth: '1' },
        raw: '{oops',
      }),
    ).toEqual({
      contains: '404',
      depth: 3,
      exact: true,
      values: ['a', 'b'],
      kind: 'a',
      either: '7',
      locator: { name: '2024', nth: 1 },
      raw: '{oops',
    });
    expect(coerce(z.literal('x'), 'x')).toBe('x');
    expect(coerce(z.string(), true)).toBe(true);
  });
});

describe('runCli', () => {
  it('prints usage, per-tool help and rejects unknown commands', async () => {
    const usage = io();
    expect(await runCli([], api, usage.sink)).toBe(0);
    expect(usage.out[0]).toContain('Usage: eab <command>');
    expect(usage.out[0]).toContain('  act         Perform user actions');
    const help = io();
    expect(await runCli(['wait_for', '--help'], api, help.sink)).toBe(0);
    expect(help.out[0]).toContain('--condition (required)');
    expect(help.out[0]).toContain('--timeoutMs Default 10000.');
    const unknown = io();
    expect(await runCli(['explode'], api, unknown.sink)).toBe(2);
    expect(unknown.err[0]).toContain('Unknown command "explode"');
    const bad = io();
    expect(await runCli(['act', 'x'], api, bad.sink)).toBe(2);
  });

  it('lists apps and runs a tool against the newest app (or --pid), then disconnects', async () => {
    const listed = io();
    expect(await runCli(['list'], api, listed.sink)).toBe(0);
    expect(listed.out[0]).toContain('pid 4242: demo 1.2.3');
    const connects: unknown[] = [];
    const counting: ClientApi = {
      ...api,
      connect: (options) => (connects.push(options), api.connect(options)),
    };
    calls.length = 0;
    const found = io();
    expect(await runCli(['find', '--role', 'button', '--pid', '4242'], counting, found.sink)).toBe(0);
    expect(connects).toEqual([{ pid: 4242 }]);
    expect(calls).toEqual([{ method: 'dom.find', params: { locator: { role: 'button' } } }]);
    expect(found.out[0]).toContain('- button "Go" [e2]');
  });

  it('reports invalid input and bridge errors on stderr with exit 1', async () => {
    const invalid = io();
    expect(await runCli(['act', '--actions', '[]'], api, invalid.sink)).toBe(1);
    expect(invalid.err[0]).toContain('Error [INVALID_PARAMS]: invalid input: actions');
    const failing = io();
    const refusing: ClientApi = { ...api, connect: () => Promise.reject(new Error('connection refused')) };
    expect(await runCli(['targets'], refusing, failing.sink)).toBe(1);
    expect(failing.err[0]).toContain('connection refused');
  });

  it('saves images to --out or a timestamped file', async () => {
    const shot = { data: { mimeType: 'image/jpeg', width: 1, height: 1, base64: 'aGk=' }, limitations: [] };
    const shooting: ClientApi = {
      ...api,
      connect: () => Promise.resolve(fakeClient({ 'screenshot.take': shot })),
    };
    const named = io();
    expect(await runCli(['screenshot', '--out', 'page.jpg'], shooting, named.sink)).toBe(0);
    expect(named.out).toEqual(['Screenshot 1×1 (image/jpeg).', 'Image saved to page.jpg']);
    expect(Buffer.from(named.files.get('page.jpg') ?? []).toString()).toBe('hi');
    const stamped = io();
    await runCli(['screenshot'], shooting, stamped.sink);
    expect([...stamped.files.keys()]).toEqual(['screenshot-1700.jpg']);
  });
});

describe('eab doctor', () => {
  it('reports each app as reachable or not, connecting as an observer', async () => {
    const roles: unknown[] = [];
    const twoApps: ClientApi = {
      ...api,
      listInstances: () => [
        { handshakePath: '/x/1.json', handshake: { ...handshake, pid: 1 } },
        { handshakePath: '/x/2.json', handshake: { ...handshake, pid: 2 } },
      ],
      connect: (options) => {
        roles.push(options.role);
        return options.handshakePath === '/x/1.json'
          ? Promise.resolve(fakeClient())
          : Promise.reject(new Error('bad token'));
      },
    };
    const report = io();
    expect(await runCli(['doctor'], twoApps, report.sink)).toBe(1);
    expect(roles).toEqual(['observer', 'observer']);
    expect(report.out[0]).toMatch(/^Endpoint directory: /);
    expect(report.out[0]).toContain('OK   pid 1 demo 1.2.3 (Electron 45.0.0): protocol');
    expect(report.out[0]).toContain('FAIL pid 2 demo 1.2.3 (Electron 45.0.0): Error [INTERNAL]: bad token');
    const none = io();
    expect(await runCli(['doctor'], { ...api, listInstances: () => [] }, none.sink)).toBe(0);
    expect(none.out[0]).toContain('No bridge-enabled apps are running.');
  });

  it('reads an executable’s fuses and says which launch strategies can work', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'eab-doctor-'));
    try {
      const binary = (wire: string): string => {
        const file = join(directory, `electron-${wire}`);
        const bytes = Buffer.concat([
          Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
          Buffer.from([1, wire.length]),
          Buffer.from(wire),
        ]);
        writeFileSync(file, bytes);
        return file;
      };
      const open = io();
      expect(await runCli(['doctor', binary('0011')], api, open.sink)).toBe(0);
      expect(open.out[0]).toContain('EnableNodeOptionsEnvironmentVariable: on');
      expect(open.out[0]).toContain('node-options: possible');
      const fused = io();
      expect(await runCli(['doctor', binary('0000')], api, fused.sink)).toBe(1);
      expect(fused.out[0]).toContain('inspector: blocked (EnableNodeCliInspectArguments is off)');
      expect(fused.out[0]).toContain('use Integrated mode');
      const plain = join(directory, 'plain');
      writeFileSync(plain, 'x');
      const unknown = io();
      expect(await runCli(['doctor', plain], api, unknown.sink)).toBe(0);
      expect(unknown.out[0]).toContain('Fuses: none found');
      const missing = io();
      expect(await runCli(['doctor', join(directory, 'nope')], api, missing.sink)).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
