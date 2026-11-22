import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BridgeError } from '@electron-agent-bridge/core';
import { afterEach, describe, expect, it } from 'vitest';

import type { BridgeClient } from '../api/bridge-client.js';
import { parseFlow } from './flow-codec.js';
import { flowSlug, runFlow, safeFileName } from './flow-runner.js';
import type { Flow } from './flow-schema.js';
import { toJunit } from './junit.js';
import { findFlowFiles, runFlowFiles, type FlowApi } from './run-flow-files.js';

type Handler = (params: Record<string, unknown>) => unknown;

/** A client whose methods answer from `handlers` (data only), recording every call. */
function fakeClient(handlers: Record<string, Handler>) {
  const calls: [string, Record<string, unknown>][] = [];
  const client = {
    closed: false,
    call: (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      const handler = handlers[method];
      if (!handler) return Promise.reject(new BridgeError('UNSUPPORTED', `${method} not faked`));
      try {
        return Promise.resolve({ data: handler(params), limitations: [] });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    close() {
      this.closed = true;
    },
  };
  return { client: client as unknown as BridgeClient & { closed: boolean }, calls };
}

const okAction = {
  steps: [{ type: 'click', ok: true, timings: { actionMs: 1, settleMs: 1 } }],
  observations: {},
};

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});
const tempDir = () => (scratch = mkdtempSync(join(tmpdir(), 'eab-flow-')));

describe('parseFlow', () => {
  it('reads YAML flows with defaults and env interpolation', () => {
    const flow = parseFlow(
      [
        'name: Checkout',
        'app:',
        '  launch: { executable: "${env.ELECTRON}", args: ["${env.APP}"] }',
        'timeoutMs: 5000',
        'steps:',
        '  - act: { type: click, locator: { role: button, name: Save } }',
        '  - name: confirm',
        '    expect: { text: Saved }',
        '    target: main',
        '  - menu: [File, Open]',
        '  - reset: true',
      ].join('\n'),
      { env: { ELECTRON: '/bin/electron', APP: '/app' } },
    );
    expect(flow.app).toEqual({ launch: { executable: '/bin/electron', args: ['/app'] } });
    expect(flow.steps).toHaveLength(4);
    expect(flow.steps[1]).toEqual({ name: 'confirm', target: 'main', expect: { text: 'Saved' } });
  });

  it('reports problems with file, line and step path', () => {
    const bad = (text: string, env: Record<string, string> = {}) => {
      try {
        parseFlow(text, { file: 'f.yaml', env });
      } catch (error) {
        return (error as BridgeError).message;
      }
      return 'parsed';
    };
    expect(bad('name: x\nsteps:\n  - act: { type: click }\n')).toMatch(/^f\.yaml:3: steps\[0\]\.act/);
    expect(bad('name: x\nsteps:\n  - nothing: 1\n')).toMatch(
      /^f\.yaml:3: steps\[0\]: a step needs exactly one of act, wait/,
    );
    expect(
      bad('name: x\nsteps:\n  - { act: { type: press, key: a }, wait: { kind: url, contains: a } }\n'),
    ).toContain('found act and wait');
    expect(bad('name: x\nsteps:\n  - expect: { colour: red }\n')).toContain('expect one of element, text');
    expect(bad('name: x\nsteps:\n  - expect: { text: "" }\n')).toMatch(
      /^f\.yaml:3: steps\[0\]\.expect\.text/,
    );
    expect(bad('name: x\nsteps:\n  - expect: { text: a }\n    colour: red\n')).toContain('steps[0]');
    expect(bad('name: x\nsteps: []\n')).toMatch(/^f\.yaml:2: steps/);
    expect(bad('steps: [{ reset: true }]\n')).toContain('name');
    expect(bad('name: "${env.MISSING}"\nsteps: [{ reset: true }]\n')).toBe(
      'f.yaml:1: name: environment variable MISSING is not set',
    );
    expect(bad('name: x\n  steps: [')).toMatch(/^f\.yaml:\d+: /);
  });
});

describe('runFlow', () => {
  const flow = (steps: unknown[], extra: Record<string, unknown> = {}): Flow =>
    parseFlow(JSON.stringify({ name: 'Order flow', steps, ...extra }));

  it('runs steps in order with timeouts and targets, and passes', async () => {
    const { client, calls } = fakeClient({
      'action.run': () => okAction,
      'wait.for': () => ({ elapsedMs: 1, observed: 'ok' }),
      'dialog.stub': () => ({ queued: 1 }),
      'menu.click': () => ({ label: 'Open' }),
      'session.reset': () => ({ reset: true }),
      'app.info': () => ({ windows: [{ id: 3, target: 'wc1', focused: true }] }),
      'targets.list': () => ({ targets: [{ id: 'wc1', name: 'main' }] }),
      'window.control': () => ({}),
    });
    const seen: string[] = [];
    const result = await runFlow(
      flow(
        [
          { act: [{ type: 'click', locator: { role: 'button', name: 'Save' } }], timeoutMs: 50 },
          { expect: { element: { role: 'status' }, state: 'visible' } },
          { expect: { state: { store: 'cart', path: 'count', equals: 1 } } },
          { stub: { method: 'showOpenDialog', response: { filePaths: ['/a'] } } },
          { menu: { id: 'file.open' } },
          { window: { action: 'minimize' } },
          { reset: true },
        ],
        { target: 'main', timeoutMs: 2000 },
      ),
      { client, onStep: (step) => seen.push(`${step.status} ${step.name}`) },
    );
    expect(result.passed).toBe(true);
    expect(seen).toEqual([
      'passed click',
      'passed expect element',
      'passed expect state',
      'passed stub showOpenDialog',
      'passed menu file.open',
      'passed window minimize',
      'passed reset',
    ]);
    // First the log cursor (for "since the flow started"), then the steps.
    expect(calls[0]?.[0]).toBe('logs.query');
    expect(calls[1]).toEqual([
      'action.run',
      expect.objectContaining({ target: 'main', timeoutMs: 50, delta: false }),
    ]);
    expect(calls[2]).toEqual([
      'wait.for',
      {
        target: 'main',
        condition: { kind: 'element', locator: { role: 'status' }, state: 'visible' },
        timeoutMs: 2000,
      },
    ]);
    expect(calls.find(([method]) => method === 'window.control')?.[1]).toEqual({
      window: 3,
      action: 'minimize',
    });
  });

  it('stops at the first failure, skips the rest, keeps going past soft failures, and saves artifacts', async () => {
    const directory = tempDir();
    const { client } = fakeClient({
      'action.run': () => ({
        steps: [
          {
            type: 'click',
            ok: false,
            error: { code: 'NOT_FOUND', message: 'no button', hint: 'snapshot' },
            timings: { actionMs: 0, settleMs: 0 },
          },
        ],
        observations: {},
      }),
      'wait.for': () => {
        throw new BridgeError('TIMEOUT', 'text "Saved" not met');
      },
      'snapshot.take': () => ({ title: 'Shop', url: 'file:///x', text: '- button "Pay" [e1]' }),
      'screenshot.take': () => ({ mimeType: 'image/png', width: 1, height: 1, base64: 'iVBORw0KGgo=' }),
      'logs.query': () => ({
        items: [{ level: 'error', source: 'renderer', text: 'boom' }],
        nextSeq: 1,
        more: false,
        dropped: 0,
      }),
    });
    const result = await runFlow(
      flow([
        { expect: { text: 'Saved' }, continueOnError: true },
        { act: { type: 'click', locator: { role: 'button', name: 'Save' } } },
        { reset: true },
      ]),
      { client, artifactsDir: directory },
    );
    expect(result.passed).toBe(false);
    expect(result.steps.map((step) => [step.status, step.error?.code])).toEqual([
      ['failed', 'TIMEOUT'],
      ['failed', 'NOT_FOUND'],
      ['skipped', undefined],
    ]);
    expect(result.steps[1]?.error).toEqual({
      code: 'NOT_FOUND',
      message: 'click: no button',
      hint: 'snapshot',
    });
    const files = readdirSync(join(directory, 'order-flow')).sort();
    expect(files).toEqual([
      'step-1-failed.logs.txt',
      'step-1-failed.png',
      'step-1-failed.snapshot.txt',
      'step-2-failed.logs.txt',
      'step-2-failed.png',
      'step-2-failed.snapshot.txt',
    ]);
    expect(readFileSync(join(directory, 'order-flow', 'step-2-failed.snapshot.txt'), 'utf8')).toContain(
      'button "Pay"',
    );
  });

  it('waits for a menu item the app has not built yet', async () => {
    let tries = 0;
    const { client } = fakeClient({
      'menu.click': () => {
        tries++;
        if (tries < 3) throw new BridgeError('NOT_FOUND', 'no menu item "Open…" in File');
        return { label: 'Open…' };
      },
    });
    const result = await runFlow(flow([{ menu: ['File', 'Open…'] }]), {
      client,
      sleep: () => Promise.resolve(),
    });
    expect([result.passed, tries]).toEqual([true, 3]);
  });

  it('checks IPC and console errors since the flow started, and saves screenshots', async () => {
    const directory = tempDir();
    let ipcReads = 0;
    const { client } = fakeClient({
      'ipc.query': (params) => {
        // Before the flow: 7 old messages. Then one new on the second poll.
        if (params['channel'] === undefined) return { items: [], nextSeq: 7, more: false };
        ipcReads++;
        return {
          items: ipcReads > 1 ? [{ seq: 8, channel: 'orders:save' }] : [],
          nextSeq: ipcReads > 1 ? 8 : 7,
          more: false,
        };
      },
      'logs.query': (params) =>
        params['minLevel'] === undefined
          ? { items: [], nextSeq: 40, more: false }
          : { items: params['since'] === 40 ? [] : [{ text: 'old' }], nextSeq: 40, more: false },
      'screenshot.take': () => ({ mimeType: 'image/png', width: 1, height: 1, base64: 'iVBORw0KGgo=' }),
    });
    const result = await runFlow(
      flow([
        { expect: { ipc: { channel: 'orders:*' } } },
        { expect: { noConsoleErrors: true } },
        { screenshot: { file: '../escape.png' } },
      ]),
      { client, artifactsDir: directory, sleep: () => Promise.resolve() },
    );
    expect(result.steps.map((step) => step.status)).toEqual(['passed', 'passed', 'passed']);
    expect(result.steps[2]?.artifacts).toEqual([join(directory, 'order-flow', '__escape.png')]);
    const never = await runFlow(flow([{ expect: { ipc: { channel: 'never', min: 2 } }, timeoutMs: 0 }]), {
      client,
      sleep: () => Promise.resolve(),
    });
    expect(never.steps[0]?.error?.message).toContain('expected 2 IPC message(s) on never');
  });
});

describe('artifact names', () => {
  it('keeps step-supplied file names inside the folder and flow folders readable', () => {
    expect(['../x.png', '..', 'C:x.png', 'a:b.png', '.hidden', '', 'ok.png'].map(safeFileName)).toEqual([
      '__x.png',
      '_',
      'C_x.png',
      'a_b.png',
      '_hidden',
      'file',
      'ok.png',
    ]);
    expect(['Login!', '注文 フロー', '!!!'].map(flowSlug)).toEqual(['login', '注文-フロー', 'flow']);
  });
});

describe('runFlowFiles and JUnit', () => {
  it('runs every file, launching or connecting per flow, and reports bad files as failed flows', async () => {
    const directory = tempDir();
    writeFileSync(
      join(directory, 'a.flow.yaml'),
      'name: First\napp: { connect: { pid: 42 } }\nsteps: [{ reset: true }]\n',
    );
    mkdirSync(join(directory, 'sub'));
    mkdirSync(join(directory, 'dir.flow.yaml'));
    writeFileSync(
      join(directory, 'sub', 'b.flow.yml'),
      'name: Second <&>\napp: { launch: { executable: /bin/app, args: [x] } }\nsteps: [{ reset: true }]\n',
    );
    writeFileSync(join(directory, 'package.json'), '{}');
    writeFileSync(join(directory, 'c.flow.json'), '{"name": "Broken", "steps": [{"bogus": 1}]}');
    writeFileSync(join(directory, 'notes.txt'), 'ignored');
    const connected = fakeClient({ 'session.reset': () => ({ reset: true }) });
    const launchedClient = fakeClient({ 'session.reset': () => ({ reset: true }) });
    const requests: unknown[] = [];
    let closedLaunch = false;
    const api: FlowApi = {
      connect: (options) => {
        requests.push(['connect', options]);
        return Promise.resolve(connected.client);
      },
      launch: (options) => {
        requests.push(['launch', options]);
        return Promise.resolve({
          client: launchedClient.client,
          close: () => {
            closedLaunch = true;
            return Promise.resolve();
          },
        } as never);
      },
    };
    const files = findFlowFiles([directory]);
    expect(files.map((file) => file.slice(directory.length + 1))).toEqual([
      'a.flow.yaml',
      'c.flow.json',
      join('sub', 'b.flow.yml'),
    ]);
    const finished: string[] = [];
    const results = await runFlowFiles(files, {
      api,
      env: {},
      onFlowResult: (result) => finished.push(result.name),
    });
    expect(finished).toEqual(results.map((result) => result.name));
    expect(results.map((result) => [result.name, result.passed])).toEqual([
      ['First', true],
      [join(directory, 'c.flow.json'), false],
      ['Second <&>', true],
    ]);
    expect(requests).toEqual([
      ['connect', { pid: 42 }],
      ['launch', { executable: '/bin/app', args: ['x'] }],
    ]);
    expect(connected.client.closed).toBe(true);
    expect(closedLaunch).toBe(true);
    expect(results[1]?.error?.message).toContain('a step needs exactly one of');
    // --pid wins over the flow's own app.
    await runFlowFiles([join(directory, 'sub', 'b.flow.yml')], { api, pid: 7, env: {} });
    expect(requests.at(-1)).toEqual(['connect', { pid: 7 }]);
    const unreachable = await runFlowFiles([join(directory, 'a.flow.yaml')], {
      api: { ...api, connect: () => Promise.reject(new BridgeError('NOT_FOUND', 'no app')) },
      env: {},
    });
    expect(unreachable[0]).toMatchObject({ passed: false, error: { code: 'NOT_FOUND' } });

    const xml = toJunit([
      ...results,
      {
        name: 'Steps',
        passed: false,
        durationMs: 1500,
        steps: [
          {
            index: 0,
            name: 'click',
            status: 'failed',
            durationMs: 1000,
            error: { code: 'TIMEOUT', message: 'x "y"', hint: 'h' },
            artifacts: ['a.png'],
          },
          { index: 1, name: 'reset', status: 'skipped', durationMs: 0, artifacts: [] },
        ],
      },
    ]);
    expect(xml).toContain('<testsuites name="eab flows" tests="5" failures="2"');
    expect(xml).toContain('name="Second &lt;&amp;&gt;"');
    expect(xml).toContain('<failure type="TIMEOUT" message="x &quot;y&quot;">h\na.png</failure>');
    expect(xml).toContain('<skipped/>');
    expect(xml).toContain('<testsuite name="Steps" tests="2" failures="1" skipped="1" time="1.500">');
  });
});
