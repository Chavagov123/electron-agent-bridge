// @vitest-environment happy-dom
import type { WaitCondition } from '@eab/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgent, type AgentResult, type PageAgent } from './agent.js';

let agent: PageAgent;

beforeEach(() => {
  document.body.innerHTML = '';
  agent = createAgent(window, 'test');
});

afterEach(() => {
  vi.restoreAllMocks();
});

function refsOf(fragment: string): string[] {
  const result = agent.snapshot({});
  if (!result.ok) throw new Error(result.error);
  return result.value.text
    .split('\n')
    .filter((line) => line.includes(fragment))
    .map((line) => /\[(e\d+)\]/.exec(line)?.[1] ?? '');
}

function value<T>(result: AgentResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

function layOutAll(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 10, y: 10, width: 50, height: 20 }),
  );
  vi.spyOn(document, 'elementFromPoint').mockImplementation(() => document.querySelector('button'));
}

describe('stale-ref healing', () => {
  it('never swaps a per-row control for another row’s', async () => {
    document.body.innerHTML = '<ul><li>A <button>Delete</button></li><li>B <button>Delete</button></li></ul>';
    const [, second] = refsOf('button "Delete"');
    // Row A deleted; the list re-renders: both old buttons are gone, one new "Delete" remains.
    document.body.innerHTML = '<ul><li>B <button>Delete</button></li></ul>';
    layOutAll();
    const result = await agent.actionTarget({ ref: second ?? '' }, { enabled: true, hitTest: true });
    expect(result).toMatchObject({ ok: false, code: 'STALE_REF' });
  });

  it('heals when the only element with that role and name was re-created', async () => {
    document.body.innerHTML = '<button>Save</button>';
    const [ref] = refsOf('button "Save"');
    document.body.innerHTML = '<button>Save</button>';
    layOutAll();
    const result = value(await agent.actionTarget({ ref: ref ?? '' }, { enabled: true, hitTest: true }));
    expect(result.healed).toBe(true);
  });
});

describe('targets that need not be visible', () => {
  it('resolves a hidden file input without geometry, still refusing a disabled one', async () => {
    document.body.innerHTML = `
      <label for="f">Attach</label><input id="f" type="file" style="display:none">
      <input id="g" type="file" aria-label="Locked" disabled hidden>`;
    const present = { enabled: true, hitTest: false, visible: false };
    expect(value(await agent.actionTarget({ css: '#f' }, present))).toMatchObject({
      inputType: 'file',
      x: 0,
      y: 0,
    });
    expect(await agent.actionTarget({ css: '#g' }, present)).toMatchObject({ ok: false, code: 'DISABLED' });
    expect(await agent.actionTarget({ css: '#f' }, { enabled: true, hitTest: false })).toMatchObject({
      ok: false,
    });
  });

  it('finds hidden elements by role, name or text over the whole document', async () => {
    document.body.innerHTML = `
      <input type="file" aria-label="Upload photo" hidden>
      <div hidden><span>Secret   note</span></div>`;
    const present = { enabled: false, hitTest: false, visible: false };
    expect(value(await agent.actionTarget({ name: 'Upload photo' }, present)).inputType).toBe('file');
    expect(value(await agent.actionTarget({ text: 'secret note' }, present)).tag).toBe('span');
    expect(await agent.actionTarget({ role: 'checkbox' }, present)).toMatchObject({ code: 'NOT_FOUND' });
    expect(value(await agent.actionTarget({ text: 'note', nth: 0 }, present)).tag).toBe('span');
  });
});

describe('element waits are about presence for attached and detached', () => {
  const check = (condition: WaitCondition) => value(agent.check(condition));

  it('treats a hidden dialog as attached, not detached', () => {
    document.body.innerHTML = '<div role="dialog" aria-label="Confirm" hidden>Sure?</div>';
    const dialog = { role: 'dialog', name: 'Confirm' };
    expect(check({ kind: 'element', locator: dialog, state: 'attached' })).toEqual({
      met: true,
      observed: '1 match(es), 0 visible, 0 enabled',
    });
    expect(check({ kind: 'element', locator: dialog, state: 'detached' }).met).toBe(false);
    expect(check({ kind: 'element', locator: dialog, state: 'hidden' }).met).toBe(true);
    document.body.innerHTML = '';
    expect(check({ kind: 'element', locator: dialog, state: 'detached' }).met).toBe(true);
  });
});

describe('HTML5 drag from inside a draggable element', () => {
  it('reports the target draggable and starts the drag at the draggable ancestor', async () => {
    document.body.innerHTML = `
      <div id="card" draggable="true"><button>Handle</button></div><ul aria-label="Done"><li>x</li></ul>`;
    layOutAll();
    const handle = value(await agent.actionTarget({ role: 'button' }, { enabled: true, hitTest: true }));
    expect(handle.draggable).toBe(true);
    const started: EventTarget[] = [];
    document.addEventListener('dragstart', (event) => started.push(event.target!));
    const [done] = refsOf('list "Done"');
    value(agent.drag(handle.ref, done ?? ''));
    expect(started).toEqual([document.getElementById('card')]);
  });
});

describe('element box for screenshots', () => {
  it('returns the viewport box of a visible element, and refuses hidden or empty ones', () => {
    document.body.innerHTML = '<button>Save</button><button hidden>Ghost</button><span id="e"></span>';
    layOutAll();
    expect(value(agent.box({ role: 'button', name: 'Save' }))).toEqual({
      x: 10,
      y: 10,
      width: 50,
      height: 20,
      clipped: false,
    });
    expect(agent.box({ css: 'button[hidden]' })).toMatchObject({ ok: false, code: 'HIDDEN' });
    vi.restoreAllMocks();
    expect(agent.box({ css: '#e' })).toMatchObject({ ok: false, code: 'HIDDEN' });
  });
});

describe('element box clipping', () => {
  it('clips to the window without scrolling, and is OFF_SCREEN when nothing is visible', () => {
    document.body.innerHTML = '<ul aria-label="Long"><li>a</li></ul><button>Far</button>';
    const list = document.querySelector('ul')!;
    const far = document.querySelector('button')!;
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: -100, width: 200, height: window.innerHeight + 300 }),
    );
    vi.spyOn(far, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: window.innerHeight + 50, width: 80, height: 20 }),
    );
    expect(value(agent.box({ role: 'list' }))).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: window.innerHeight,
      clipped: true,
    });
    expect(agent.box({ role: 'button' })).toMatchObject({ ok: false, code: 'OFF_SCREEN' });
    expect(scroll).not.toHaveBeenCalled();
  });
});
