import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseFlow } from '@electron-agent-bridge/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { ClientApi } from '../session/session-manager.js';
import { api, callText, calls, closeClient, connectedClient, fakeClient } from '../testing/mcp-harness.js';
import { runCli, type CliIo } from './run-cli.js';

function io(stopAfter?: Promise<void>) {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, Uint8Array>();
  const sink: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    writeFile: (path, data) => files.set(path, data),
    now: () => 0,
    ...(stopAfter === undefined ? {} : { untilStopped: () => stopAfter }),
  };
  return { sink, out, err, files };
}

const recorded = [
  {
    seq: 1,
    ts: 1,
    target: 'main',
    source: 'user',
    action: { type: 'fill', locator: { css: '#pw' }, value: '' },
    secret: true,
  },
  {
    seq: 2,
    ts: 2,
    target: 'main',
    source: 'user',
    action: { type: 'click', locator: { role: 'button', name: 'Sign in', exact: true } },
  },
];
const page = (items: unknown[], more = false) => ({
  data: { items, nextSeq: items.length + 1, dropped: 0, more, recording: true },
  limitations: [],
});

function recordingApi(): ClientApi {
  let served = false;
  const client = fakeClient({
    'record.start': { data: { recording: true, nextSeq: 1 }, limitations: [] },
    'record.stop': { data: { recording: false }, limitations: [] },
  });
  const call = client.call.bind(client);
  return {
    ...api,
    connect: () =>
      Promise.resolve(
        Object.assign(Object.create(client) as typeof client, {
          call: (method: string, params: unknown) => {
            if (method !== 'record.events') return call(method as never, params as never);
            calls.push({ method, params });
            const answer = served ? page([]) : page(recorded);
            served = true;
            return Promise.resolve(answer);
          },
        }),
      ),
  };
}

let scratch: string | undefined;
afterEach(async () => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
  calls.length = 0;
  await closeClient();
});

describe('eab record', () => {
  it('records until stopped and writes a flow that eab run reads', async () => {
    const { sink, out, files } = io(Promise.resolve());
    expect(await runCli(['record', '--out', 'login.flow.yaml', '--pid', '42'], recordingApi(), sink)).toBe(0);
    const flow = parseFlow(Buffer.from(files.get('login.flow.yaml') ?? []).toString(), {
      env: { FLOW_SECRET_1: 'x' },
    });
    expect(flow.name).toBe('login');
    expect(flow.steps).toHaveLength(2);
    expect(out).toContain('Recorded 2 action(s) into login.flow.yaml.');
    expect(out).toContain('Password fields read FLOW_SECRET_1 from the environment.');
    expect(calls.map((call) => call.method)).toEqual(expect.arrayContaining(['record.start', 'record.stop']));
  });

  it('records for a fixed duration and refuses a bad command line', async () => {
    const { sink, files } = io();
    expect(
      await runCli(
        ['record', '--out', 'f.yaml', '--duration', '10', '--name', 'Timed'],
        recordingApi(),
        sink,
      ),
    ).toBe(0);
    expect(
      parseFlow(Buffer.from(files.get('f.yaml') ?? []).toString(), { env: { FLOW_SECRET_1: '' } }).name,
    ).toBe('Timed');
    for (const argv of [
      ['record'],
      ['record', '--out'],
      ['record', '--out', 'x', '--pid', 'abc'],
      ['record', '--bogus', '1'],
    ]) {
      const bad = io();
      expect(await runCli(argv, api, bad.sink)).toBe(2);
      expect(bad.err.join('\n')).toContain('eab record --out');
    }
  });
});

describe('eab export', () => {
  it('writes a Playwright test and reports what it could not carry over', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'eab-export-'));
    const file = join(scratch, 'a.flow.yaml');
    writeFileSync(
      file,
      'name: A\nsteps:\n  - act: { type: fill, locator: { css: "#q" }, value: "${env.QUERY}" }\n  - expect: { ipc: { channel: "x:*" } }\n',
    );
    const { sink, out, err, files } = io();
    expect(await runCli(['export', file, '--playwright', '--out', 'a.spec.ts'], api, sink)).toBe(0);
    const code = Buffer.from(files.get('a.spec.ts') ?? []).toString();
    expect(code).toContain('fill(`${process.env["QUERY"] ?? \'\'}`)');
    expect(err.some((line) => line.startsWith('Warning: steps[1]: IPC check'))).toBe(true);
    expect(out).toContain('Wrote a.spec.ts (2 warning(s)).');
    const printed = io();
    expect(await runCli(['export', file, '--playwright'], api, printed.sink)).toBe(0);
    expect(printed.out[0]).toContain('test("A"');
    expect(await runCli(['export', file], api, io().sink)).toBe(2);
    expect(await runCli(['export', join(scratch, 'missing.yaml'), '--playwright'], api, io().sink)).toBe(1);
    expect(readFileSync(file, 'utf8')).toContain('QUERY');
  });
});

describe('session recording through MCP', () => {
  it('starts, stops and returns the flow, writing it when asked', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'eab-mcp-record-'));
    const client = await connectedClient(recordingApi());
    await callText(client, 'session', { action: 'connect' });
    expect((await callText(client, 'session', { action: 'recordStart' })).text).toContain('Recording.');
    const out = join(scratch, 'r.flow.yaml');
    const stopped = await callText(client, 'session', { action: 'recordStop', out, name: 'Sign in' });
    expect(stopped.text).toContain('Recorded 2 action(s).');
    expect(stopped.text).toContain('name: Sign in');
    expect(readFileSync(out, 'utf8')).toContain('Sign in');
  });
});
