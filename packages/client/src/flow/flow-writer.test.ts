import { runInNewContext } from 'node:vm';

import type { RecordedEvent } from '@electron-agent-bridge/core';
import { describe, expect, it } from 'vitest';

import { parseFlow } from './flow-codec.js';
import type { Flow } from './flow-schema.js';
import { flowFromRecording, stringifyFlow } from './flow-writer.js';
import { toPlaywright } from './playwright-export.js';

const event = (
  seq: number,
  action: RecordedEvent['action'],
  extra: Partial<RecordedEvent> = {},
): RecordedEvent => ({
  seq,
  ts: seq,
  target: 'main',
  source: 'user',
  action,
  ...extra,
});
const save = { role: 'button', name: 'Save', exact: true };
const email = { role: 'textbox', name: 'Email', exact: true };

describe('stringifyFlow', () => {
  it('writes YAML that parses back to the same flow', () => {
    const flow: Flow = {
      name: 'Order',
      description: 'Places an order',
      app: { launch: { executable: '/bin/app', args: ['.'] } },
      target: 'main',
      timeoutMs: 5_000,
      steps: [
        { act: { type: 'fill', locator: email, value: 'a: b # not a comment' } },
        {
          name: 'save it',
          act: [
            { type: 'click', locator: save },
            { type: 'press', key: 'Control+S' },
          ],
        },
        { expect: { text: 'Saved' } },
        { wait: { kind: 'url', contains: '/done' }, timeoutMs: 1_000 },
        { menu: ['File', 'Open…'] },
      ],
    };
    const text = stringifyFlow(flow);
    expect(text.indexOf('name:')).toBe(0);
    expect(parseFlow(text)).toEqual(flow);
  });
});

describe('flowFromRecording', () => {
  it('makes one act step per action, collapses typing and double clicks, and keeps secrets out', () => {
    const { flow, secrets, notes } = flowFromRecording(
      [
        event(1, { type: 'fill', locator: email, value: 'a' }),
        event(2, { type: 'fill', locator: email, value: 'a@b.test' }),
        event(3, { type: 'fill', locator: { css: '#pw' }, value: '' }, { secret: true }),
        event(4, { type: 'click', locator: save }),
        event(5, { type: 'click', locator: save, clickCount: 2 }),
        event(6, { type: 'click', locator: { text: 'Help', exact: true } }, { target: 'help' }),
        event(7, { type: 'press', key: 'Enter' }, { source: 'agent' }),
      ],
      { name: 'Recorded' },
    );
    expect(flow).toEqual({
      name: 'Recorded',
      target: 'main',
      steps: [
        { act: { type: 'fill', locator: email, value: 'a@b.test' } },
        { act: { type: 'fill', locator: { css: '#pw' }, value: '${env.FLOW_SECRET_1}' } },
        { act: { type: 'click', locator: save, clickCount: 2 } },
        { target: 'help', act: { type: 'click', locator: { text: 'Help', exact: true } } },
        { act: { type: 'press', key: 'Enter' } },
      ],
    });
    expect(secrets).toEqual(['FLOW_SECRET_1']);
    expect(notes).toEqual([]);
    expect(parseFlow(stringifyFlow(flow), { env: { FLOW_SECRET_1: 'pw' } }).steps[1]).toEqual({
      act: { type: 'fill', locator: { css: '#pw' }, value: 'pw' },
    });
  });

  it('still writes a valid flow for an empty recording', () => {
    const { flow, notes } = flowFromRecording([], { name: 'Empty', app: { connect: {} } });
    expect(notes).toEqual(['nothing was recorded']);
    expect(parseFlow(stringifyFlow(flow))).toEqual(flow);
  });
});

describe('toPlaywright', () => {
  it('maps locators, actions and checks to Playwright for Electron', () => {
    const flow: Flow = {
      name: 'Order',
      app: { launch: { executable: '/bin/electron', args: ['app'], env: { A: '1' } } },
      steps: [
        { act: { type: 'fill', locator: email, value: '${env.USER_EMAIL}' }, timeoutMs: 2_000 },
        { act: { type: 'click', locator: { ...save, nth: 1 }, modifiers: ['Shift'] } },
        { act: { type: 'click', locator: { text: 'Row', exact: true }, clickCount: 2 } },
        {
          act: {
            type: 'fillForm',
            fields: [
              { locator: { css: '#a' }, value: true },
              { locator: { css: '#s' }, value: ['x'] },
            ],
          },
        },
        {
          act: [
            { type: 'press', key: 'Control+S' },
            { type: 'drag', from: { css: '#f' }, to: { css: '#t' } },
          ],
        },
        { target: 'settings', expect: { element: save, state: 'enabled' } },
        { expect: { url: { contains: '/done?x=1' } } },
        { expect: { noConsoleErrors: true } },
        { wait: { kind: 'element', locator: { role: 'dialog' }, state: 'detached' } },
        { menu: ['File', 'Save'] },
        { stub: { method: 'showOpenDialog', response: { canceled: true } } },
        { screenshot: { file: 'done.png' } },
      ],
    };
    const { code, warnings } = toPlaywright(flow);
    expect(code).toContain(
      "import { _electron as electron, expect, test, type Page } from '@playwright/test';",
    );
    expect(code).toContain(
      'electron.launch({ executablePath: "/bin/electron", args: ["app"], env: { ...process.env, ...{"A":"1"} }',
    );
    expect(code).toContain(
      'await (page).getByRole("textbox", { name: "Email", exact: true }).fill(`${process.env["USER_EMAIL"] ?? \'\'}`, { timeout: 2000 });',
    );
    expect(code).toContain(
      'await (page).getByRole("button", { name: "Save", exact: true }).nth(1).click({ modifiers: ["Shift"] });',
    );
    expect(code).toContain('await (page).getByText("Row", { exact: true }).dblclick();');
    expect(code).toContain('await (page).locator("#a").check();');
    expect(code).toContain('await (page).locator("#s").selectOption(["x"]);');
    expect(code).toContain('await (page).keyboard.press("Control+S");');
    expect(code).toContain('await (page).locator("#f").dragTo((page).locator("#t"));');
    expect(code).toContain(
      'await expect((await pageNamed("settings")).getByRole("button", { name: "Save", exact: true })).toBeEnabled();',
    );
    expect(code).toContain('await expect(page).toHaveURL(new RegExp("/done\\\\?x=1"));');
    expect(code).toContain('expect(consoleErrors).toEqual([]);');
    expect(code).toContain('toBeAttached({ attached: false })');
    expect(code).toContain('Menu.getApplicationMenu()');
    // Targets are named by slugs (`Index1.html` → `index1`, "Order Details" → `order-details`).
    expect(code).toContain(
      'slug(candidate.url()).includes(name) || slug(await candidate.title()).includes(name)',
    );
    expect(code).toContain('await page.screenshot({ path: "done.png" });');
    expect(warnings).toEqual([]);
  });

  it('keeps recorded text literal around environment references', () => {
    const recorded = String.raw`C:\new ` + '`x` ${env.HOME_DIR} ${require("x")}';
    const { code } = toPlaywright({
      name: 'Escapes',
      steps: [{ act: { type: 'fill', locator: { css: '#a' }, value: recorded } }],
    });
    const line = code.split('\n').find((text) => text.includes('.fill('));
    // The generated literal evaluates back to the text, with only the reference filled in: no
    // backslash escape, backtick or other `${` of the recorded text becomes code.
    const literal = /fill\((`.*`)\)/.exec(line ?? '')?.[1] ?? '';
    const evaluated = runInNewContext(literal, { process: { env: { HOME_DIR: '/home/a' } } }) as string;
    expect(evaluated).toBe(String.raw`C:\new ` + '`x` /home/a ${require("x")}');
  });

  it('lists what it cannot carry over', () => {
    const { code, warnings } = toPlaywright({
      name: 'Bridge only',
      steps: [
        { act: { type: 'click', locator: { ref: 'e12' } }, continueOnError: true },
        { expect: { ipc: { channel: 'orders:*' } } },
        { wait: { kind: 'state', path: 'orders.length', equals: 1 } },
        { stub: { method: 'showMessageBox', response: { response: 0 }, times: 2 } },
      ],
    });
    expect(code).toContain("process.env['EAB_EXECUTABLE']");
    expect(code).toContain("// Not exported (IPC check on orders:*: Playwright cannot see the app's IPC).");
    expect(warnings).toEqual([
      'app: a flow that connects to a running app is launched from EAB_EXECUTABLE and EAB_ARGS (JSON)',
      'steps[0]: continueOnError: a failing step still fails the test',
      'steps[0]: ref e12: refs last for one page load; re-record or use role and name',
      "steps[1]: IPC check on orders:*: Playwright cannot see the app's IPC",
      'steps[2]: wait for store orders.length: store state is read through the bridge',
      'steps[3]: stub times: the stub stays in place',
    ]);
  });
});

describe('toPlaywright comments', () => {
  it('keeps flow text inside its comments whatever line terminators it holds', () => {
    const breakers = ['\r', '\n', '\u2028', '\u2029'];
    const flow: Flow = {
      name: `Order${breakers.join('')}x()`,
      steps: breakers.map((breaker) => ({
        name: `open${breaker}require('child_process')`,
        act: { type: 'click', locator: { text: 'Open', exact: true } },
      })),
    };
    const { code } = toPlaywright(flow);
    const lines = code.split(/\r\n|[\r\n\u2028\u2029]/);
    // Step names only go into comments: none may start a line of its own.
    expect(lines.filter((line) => line.trimStart().startsWith("require('child_process')"))).toEqual([]);
    // The name stays within its comment (it is also a string literal, where U+2028 is legal).
    expect(lines.find((line) => line.startsWith('// Exported by eab'))).toContain('x()');
  });
});
