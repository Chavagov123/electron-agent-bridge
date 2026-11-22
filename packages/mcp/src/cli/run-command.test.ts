import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ClientApi } from '../session/session-manager.js';
import { api, fakeClient } from '../testing/mcp-harness.js';
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

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function flows(contents: Record<string, string>): string {
  scratch = mkdtempSync(join(tmpdir(), 'eab-run-'));
  for (const [name, text] of Object.entries(contents)) writeFileSync(join(scratch, name), text);
  return scratch;
}

describe('eab run', () => {
  it('runs flows, prints each step, writes JUnit and exits 0 when all pass', async () => {
    const directory = flows({ 'ok.flow.yaml': 'name: Reset only\nsteps: [{ reset: true }]\n' });
    const resetting: ClientApi = {
      ...api,
      connect: () =>
        Promise.resolve(fakeClient({ 'session.reset': { data: { reset: true }, limitations: [] } })),
    };
    const { sink, out, files } = io();
    expect(await runCli(['run', directory, '--junit', 'report.xml'], resetting, sink)).toBe(0);
    expect(out.join('\n')).toMatch(/Reset only \(.*ok\.flow\.yaml\)\n {2}✓ 1\. reset \(\d+ ms\)/);
    expect(out.at(-1)).toMatch(/^\n1 flow\(s\) passed, 0 failed/);
    expect(Buffer.from(files.get('report.xml') ?? []).toString()).toContain('tests="1" failures="0"');
  });

  it('exits 1 when a flow fails or does not parse, and 2 on a wrong command line', async () => {
    const directory = flows({ 'bad.flow.yaml': 'name: Bad\nsteps: [{ bogus: 1 }]\n' });
    const { sink, out } = io();
    expect(await runCli(['run', directory], api, sink)).toBe(1);
    expect(out.join('\n')).toMatch(/bad\.flow\.yaml\n {2}✗ .*bad\.flow\.yaml:2: steps\[0\]/);
    const wrong = io();
    expect(await runCli(['run'], api, wrong.sink)).toBe(2);
    expect(await runCli(['run', join(directory, 'missing.flow.yaml')], api, wrong.sink)).toBe(2);
    expect(await runCli(['run', directory, '--pid', 'x'], api, wrong.sink)).toBe(2);
    expect(await runCli(['run', directory, '--junit'], api, wrong.sink)).toBe(2);
    expect(await runCli(['run', directory, '--fast'], api, wrong.sink)).toBe(2);
    expect(wrong.err.join('\n')).toContain('eab run <flow file or directory>');
  });
});
