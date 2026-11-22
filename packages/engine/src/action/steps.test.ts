import type { Action } from '@eab/core';
import { describe, expect, it } from 'vitest';

import { AgentPool } from '../page/agent-pool.js';
import type { TargetDescriptor } from '../ports/target-source.js';
import { FakeAgentPage, type ScriptedAgent } from '../testing/fake-agent-page.js';
import { FakeClock } from '../testing/fake-clock.js';
import { ActionEngine } from './action-engine.js';

const bundle = { source: 'install()', version: 'test' };

function base(target: Record<string, unknown>, overrides: ScriptedAgent = {}): ScriptedAgent {
  return {
    snapshot: () => ({
      kind: 'full',
      cursor: 'c',
      text: '',
      lineCount: 0,
      truncated: false,
      collapsed: 0,
      crossOriginFrames: 0,
      url: '',
      title: '',
    }),
    live: () => ({ regions: {}, dialogs: [] }),
    quiet: () => 0,
    actionTarget: () => ({
      ref: 'e1',
      role: 'textbox',
      name: 'N',
      tag: 'input',
      inputType: 'text',
      x: 10,
      y: 20,
      editable: true,
      draggable: false,
      healed: false,
      ...target,
    }),
    focus: () => true,
    ...overrides,
  };
}

async function step(page: FakeAgentPage, action: Action) {
  const engine = new ActionEngine({ pool: new AgentPool(bundle), clock: new FakeClock() });
  const target: TargetDescriptor = {
    id: 'wc1',
    kind: 'window',
    title: '',
    url: '',
    focused: true,
    transport: page,
  };
  const result = await engine.run(target, { actions: [action], delta: false });
  return { step: result.data.steps[0], limitations: result.limitations };
}

describe('steps', () => {
  it('fill selects all and types; empty values delete; verified values need no fallback', async () => {
    let value = '';
    const page = new FakeAgentPage(base({}, { state: () => ({ value }), focus: () => ((value = ''), true) }));
    page.handle('Input.insertText', (params) => {
      value = (params as { text: string }).text;
      return {};
    });
    const { step: done, limitations } = await step(page, {
      type: 'fill',
      locator: { ref: 'e1' },
      value: 'Ann',
    });
    expect(done?.ok).toBe(true);
    expect(limitations).toEqual([]);
    const cleared = new FakeAgentPage(base({}, { state: () => ({ value: '' }) }));
    await step(cleared, { type: 'fill', locator: { ref: 'e1' }, value: '' });
    expect(cleared.sent('Input.dispatchKeyEvent').map((event) => (event as { key: string }).key)).toEqual([
      'Delete',
      'Delete',
    ]);
  });

  it('fill falls back to setting the value directly, and says so', async () => {
    const setValue: unknown[] = [];
    const page = new FakeAgentPage(
      base(
        {},
        {
          state: () => ({ value: '(555)' }),
          setValue: (...args: never[]) => (setValue.push(args), { value: '555' }),
        },
      ),
    );
    const { step: done, limitations } = await step(page, {
      type: 'fill',
      locator: { ref: 'e1' },
      value: '555',
    });
    expect(done?.ok).toBe(true);
    expect(setValue).toEqual([['e1', '555']]);
    expect(limitations[0]?.message).toContain('set directly');
  });

  it('fill rejects non-editable elements and routes <select> to option selection', async () => {
    const checkbox = new FakeAgentPage(base({ role: 'checkbox', inputType: 'checkbox', editable: false }));
    expect(
      (await step(checkbox, { type: 'fill', locator: { ref: 'e1' }, value: 'x' })).step?.error?.code,
    ).toBe('INVALID_PARAMS');
    const chosen: unknown[] = [];
    const select = new FakeAgentPage(
      base(
        { tag: 'select', role: 'combobox', editable: false },
        { selectOptions: (...args: never[]) => (chosen.push(args), ['b']) },
      ),
    );
    expect((await step(select, { type: 'fill', locator: { ref: 'e1' }, value: 'B' })).step?.ok).toBe(true);
    expect(chosen).toEqual([['e1', ['B']]]);
  });

  it('check clicks only when needed, verifies, and refuses to uncheck a radio', async () => {
    let checked = false;
    const page = new FakeAgentPage(
      base({ role: 'checkbox', inputType: 'checkbox' }, { state: () => ({ checked }) }),
    );
    page.handle('Input.dispatchMouseEvent', (params) => {
      if ((params as { type: string }).type === 'mouseReleased') checked = !checked;
      return {};
    });
    expect((await step(page, { type: 'check', locator: { ref: 'e1' } })).step?.ok).toBe(true);
    expect(checked).toBe(true);
    const presses = page.sent('Input.dispatchMouseEvent').length;
    expect((await step(page, { type: 'check', locator: { ref: 'e1' } })).step?.ok).toBe(true);
    expect(page.sent('Input.dispatchMouseEvent')).toHaveLength(presses);
    const stuck = new FakeAgentPage(base({ inputType: 'checkbox' }, { state: () => ({ checked: false }) }));
    expect((await step(stuck, { type: 'check', locator: { ref: 'e1' } })).step?.error?.code).toBe('INTERNAL');
    const radio = new FakeAgentPage(base({ inputType: 'radio' }, { state: () => ({ checked: true }) }));
    expect((await step(radio, { type: 'uncheck', locator: { ref: 'e1' } })).step?.error?.code).toBe(
      'INVALID_PARAMS',
    );
  });

  it('types and presses chords at the focused element', async () => {
    const page = new FakeAgentPage(base({}));
    await step(page, { type: 'type', locator: { ref: 'e1' }, text: 'hi' });
    expect(page.sent('Input.insertText')).toEqual([{ text: 'hi' }]);
    await step(page, { type: 'press', key: 'Control+s' });
    const keys = page.sent('Input.dispatchKeyEvent') as {
      type: string;
      key: string;
      modifiers: number;
      text?: string;
    }[];
    expect(keys.map((key) => `${key.type}:${key.key}:${key.modifiers}`)).toEqual([
      'rawKeyDown:Control:2',
      'rawKeyDown:s:2',
      'keyUp:s:2',
      'keyUp:Control:0',
    ]);
    expect(keys.every((key) => key.text === undefined)).toBe(true);
    const bad = await step(new FakeAgentPage(base({})), { type: 'press', key: 'Hyper+q' });
    expect(bad.step?.error?.code).toBe('INVALID_PARAMS');
  });

  it('scrolls with the wheel at an element or the viewport centre', async () => {
    const page = new FakeAgentPage(base({}));
    await step(page, { type: 'scroll', deltaY: 300 });
    await step(page, { type: 'scroll', locator: { ref: 'e1' }, deltaX: 10 });
    await step(page, { type: 'scroll', locator: { ref: 'e1' } });
    expect(page.sent('Input.dispatchMouseEvent')).toEqual([
      { type: 'mouseWheel', x: 500, y: 400, deltaX: 0, deltaY: 300 },
      { type: 'mouseWheel', x: 10, y: 20, deltaX: 10, deltaY: 0 },
    ]);
  });

  it('uploads files to file inputs only, explaining CDP failures', async () => {
    const page = new FakeAgentPage(base({ inputType: 'file', role: 'button' }));
    expect(
      (await step(page, { type: 'upload', locator: { ref: 'e1' }, files: ['/tmp/a.txt'] })).step?.ok,
    ).toBe(true);
    expect(page.sent('DOM.setFileInputFiles')).toEqual([{ files: ['/tmp/a.txt'], objectId: 'obj-1' }]);
    const notFile = new FakeAgentPage(base({}));
    expect(
      (await step(notFile, { type: 'upload', locator: { ref: 'e1' }, files: ['/a'] })).step?.error?.code,
    ).toBe('INVALID_PARAMS');
    const missing = new FakeAgentPage(base({ inputType: 'file' }));
    missing.handle('DOM.setFileInputFiles', () => {
      throw new Error('File not found');
    });
    const failed = await step(missing, { type: 'upload', locator: { ref: 'e1' }, files: ['/nope'] });
    expect(failed.step?.error).toMatchObject({
      code: 'INVALID_PARAMS',
      hint: expect.stringContaining('absolute') as unknown,
    });
  });

  it('drags with the pointer, or with synthetic HTML5 events for draggable elements (noted)', async () => {
    const page = new FakeAgentPage(base({}));
    await step(page, { type: 'drag', from: { ref: 'e1' }, to: { ref: 'e2' } });
    expect(page.sent('Input.dispatchMouseEvent').map((event) => (event as { type: string }).type)).toContain(
      'mousePressed',
    );
    const dragged: unknown[] = [];
    const html5 = new FakeAgentPage(
      base({ draggable: true }, { drag: (...args: never[]) => (dragged.push(args), true) }),
    );
    const { limitations } = await step(html5, { type: 'drag', from: { ref: 'e1' }, to: { ref: 'e2' } });
    expect(dragged).toEqual([['e1', 'e1']]);
    expect(limitations[0]?.message).toContain('HTML5 drag and drop');
  });

  it('fills whole forms, choosing check, select or fill per value', async () => {
    const calls: string[] = [];
    const page = new FakeAgentPage(
      base(
        {},
        {
          state: () => ({ checked: true, value: 'Ann' }),
          selectOptions: () => (calls.push('select'), ['x']),
        },
      ),
    );
    page.handle('Input.insertText', () => (calls.push('type'), {}));
    const { step: done } = await step(page, {
      type: 'fillForm',
      fields: [
        { locator: { ref: 'e1' }, value: 'Ann' },
        { locator: { ref: 'e2' }, value: true },
        { locator: { ref: 'e3' }, value: ['x'] },
      ],
    });
    expect(done?.ok).toBe(true);
    expect(calls).toEqual(['type', 'select']);
  });

  it('hover moves the mouse without requiring an enabled element', async () => {
    const seen: unknown[] = [];
    const page = new FakeAgentPage(
      base({}, { actionTarget: (...args: never[]) => (seen.push(args[1]), { ref: 'e1', x: 1, y: 2 }) }),
    );
    await step(page, { type: 'hover', locator: { ref: 'e1' } });
    expect(seen).toEqual([{ enabled: false, hitTest: true }]);
    expect(page.sent('Input.dispatchMouseEvent')).toEqual([{ type: 'mouseMoved', x: 1, y: 2, modifiers: 0 }]);
  });
});
