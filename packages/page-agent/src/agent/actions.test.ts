// @vitest-environment happy-dom
import type { Locator } from '@electron-agent-bridge/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isDisabled, isEditable, nextFrame } from './actionability.js';
import { createAgent, type AgentResult, type PageAgent } from './agent.js';

const CLICK = { enabled: true, hitTest: true };

let agent: PageAgent;

beforeEach(() => {
  document.body.innerHTML = '';
  agent = createAgent(window, 'test');
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setPage(html: string): void {
  document.body.innerHTML = html;
}

/** Snapshot the page and return the ref of the line containing `fragment`. */
function refOf(fragment: string): string {
  const result = agent.snapshot({});
  if (!result.ok) throw new Error(result.error);
  const line = result.value.text.split('\n').find((candidate) => candidate.includes(fragment));
  const ref = /\[(e\d+)\]/.exec(line ?? '')?.[1];
  if (ref === undefined) throw new Error(`no ref for ${fragment} in\n${result.value.text}`);
  return ref;
}

function failure<T>(result: AgentResult<T>): string {
  if (result.ok) throw new Error('expected a failure');
  return result.code;
}

function value<T>(result: AgentResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

/** happy-dom has no layout: give an element a box and make it what the page hit-tests at any point. */
function layOut(el: Element, box = { x: 10, y: 20, width: 100, height: 30 }, hit: Element | null = el): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect(box));
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(hit);
}

const target = (locator: Locator, requirements = CLICK) => agent.actionTarget(locator, requirements);

describe('actionTarget', () => {
  it('returns the centre point and element facts for a visible, enabled, uncovered element', async () => {
    setPage('<button id="b">Save</button>');
    const button = document.getElementById('b')!;
    layOut(button);
    expect(value(await target({ role: 'button', name: 'Save' }))).toEqual({
      ref: refOf('Save'),
      role: 'button',
      name: 'Save',
      tag: 'button',
      inputType: undefined,
      x: 60,
      y: 35,
      editable: false,
      draggable: false,
      healed: false,
    });
  });

  it('reports NOT_FOUND, AMBIGUOUS, HIDDEN and DISABLED', async () => {
    setPage(`
      <button>Twin</button><button>Twin</button>
      <button style="display:none">Ghost</button>
      <button disabled>Archive</button>
      <div role="button" aria-disabled="true">Soft</div>`);
    expect(failure(await target({ text: 'Nothing like this' }))).toBe('NOT_FOUND');
    expect(failure(await target({ role: 'button', name: 'Twin' }))).toBe('AMBIGUOUS');
    expect(failure(await target({ css: 'button[style]' }))).toBe('HIDDEN');
    expect(failure(await target({ role: 'button', name: 'Archive' }))).toBe('DISABLED');
    expect(failure(await target({ role: 'button', name: 'Soft' }))).toBe('DISABLED');
  });

  it('allows a disabled element when the action does not need it enabled (hover)', async () => {
    setPage('<button disabled>Archive</button>');
    layOut(document.querySelector('button')!);
    expect(value(await target({ role: 'button' }, { enabled: false, hitTest: false })).name).toBe('Archive');
  });

  it('reports elements with no size as HIDDEN and outside the viewport as OFF_SCREEN', async () => {
    setPage('<button>Flat</button>');
    const button = document.querySelector('button')!;
    const scroll = vi.spyOn(button, 'scrollIntoView').mockImplementation(() => undefined);
    layOut(button, { x: 0, y: 0, width: 0, height: 0 });
    expect(failure(await target({ role: 'button' }))).toBe('HIDDEN');
    layOut(button, { x: 10, y: window.innerHeight + 500, width: 50, height: 20 });
    expect(failure(await target({ role: 'button' }))).toBe('OFF_SCREEN');
    expect(scroll).toHaveBeenCalled();
  });

  it('reports OCCLUDED naming the covering element, but lets a label click its own control', async () => {
    setPage(`
      <button id="b">Save</button><div id="cover" role="dialog" aria-label="Busy"></div>
      <label id="l"><input id="c" type="checkbox"> Gift</label>`);
    layOut(document.getElementById('b')!, undefined, document.getElementById('cover'));
    expect(value(await agent.actionTarget({ css: '#b' }, { enabled: true, hitTest: false })).name).toBe(
      'Save',
    );
    const covered = await target({ css: '#b' });
    expect(covered).toMatchObject({
      ok: false,
      code: 'OCCLUDED',
      error: expect.stringContaining('dialog "Busy"') as unknown,
    });
    vi.restoreAllMocks();
    layOut(document.getElementById('c')!, undefined, document.getElementById('l'));
    expect(value(await target({ css: '#c' })).role).toBe('checkbox');
  });

  it('reports a moving element (UNSTABLE) and one removed while waiting (DETACHED)', async () => {
    setPage('<button>Run</button>');
    const button = document.querySelector('button')!;
    let top = 0;
    vi.spyOn(button, 'getBoundingClientRect').mockImplementation(() =>
      DOMRect.fromRect({ x: 0, y: (top += 5), width: 10, height: 10 }),
    );
    expect(failure(await target({ role: 'button' }))).toBe('UNSTABLE');
    vi.restoreAllMocks();
    vi.spyOn(button, 'getBoundingClientRect').mockImplementation(() => {
      button.remove();
      return DOMRect.fromRect({ x: 0, y: 0, width: 10, height: 10 });
    });
    expect(failure(await target({ css: 'button' }))).toBe('DETACHED');
  });

  it('heals a stale ref to the unique element with the same role and name', async () => {
    setPage('<button>Save</button>');
    const ref = refOf('Save');
    setPage('<p>re-rendered</p><button>Save</button>');
    layOut(document.querySelector('button')!);
    const healed = value(await target({ ref }));
    expect(healed.healed).toBe(true);
    expect(healed.ref).not.toBe(ref);
    setPage('<p>gone</p>');
    expect(failure(await target({ ref }))).toBe('STALE_REF');
    expect(failure(await target({ ref: 'e999' }))).toBe('STALE_REF');
  });
});

describe('element predicates', () => {
  it('knows what is disabled and editable', () => {
    setPage(`
      <input id="f" disabled>
      <input id="t"><input id="r" readonly><input id="x" type="checkbox">
      <textarea id="a"></textarea><textarea id="ra" readonly></textarea>
      <div id="ce" contenteditable="true"></div><div id="d"></div>`);
    const el = (id: string) => document.getElementById(id)!;
    expect(isDisabled(el('f'))).toBe(true);
    expect(isDisabled(el('t'))).toBe(false);
    expect(['t', 'r', 'x', 'a', 'ra', 'd'].map((id) => isEditable(el(id)))).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  it('resolves nextFrame even when animation frames never come', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    await expect(nextFrame(window)).resolves.toBeUndefined();
  });
});

describe('editing', () => {
  it('focuses with select-all, and rejects elements that cannot take focus', () => {
    setPage('<input aria-label="Name" value="old"><p>Text</p>');
    const input = document.querySelector('input')!;
    value(agent.focus(refOf('textbox'), true));
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
    setPage('<input aria-label="Name"><span tabindex="0" role="note">Plain</span>');
    expect(failure(agent.focus('e999', false))).toBe('STALE_REF');
  });

  it('reads and sets values through the native setter, firing input and change', () => {
    setPage('<input aria-label="Name" value="a"><input type="checkbox" aria-label="Gift" checked>');
    const events: string[] = [];
    const input = document.querySelector('input')!;
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));
    const ref = refOf('textbox');
    expect(value(agent.setValue(ref, 'Ada'))).toEqual({ value: 'Ada' });
    expect(events).toEqual(['input', 'change']);
    expect(value(agent.state(refOf('checkbox')))).toEqual({ value: 'on', checked: true });
  });

  it('sets contenteditable text and reads aria-checked widgets', () => {
    setPage(
      '<div contenteditable="true" role="textbox" aria-label="Notes">x</div><div role="switch" aria-checked="true" aria-label="Wifi"></div>',
    );
    expect(value(agent.setValue(refOf('Notes'), 'hello'))).toEqual({ value: 'hello' });
    expect(value(agent.state(refOf('Wifi')))).toEqual({ checked: true });
    expect(failure(agent.setValue(refOf('Wifi'), 'x'))).toBe('INVALID_PARAMS');
  });

  it('selects options by value or label and explains what is available', () => {
    setPage(`
      <select aria-label="Priority"><option value="lo">Low</option><option value="hi">High</option>
        <option value="x" disabled>Blocked</option></select>
      <select aria-label="Tags" multiple><option>a</option><option>b</option></select>
      <button>Not a select</button>`);
    const priority = refOf('Priority');
    expect(value(agent.selectOptions(priority, ['High']))).toEqual(['hi']);
    expect(value(agent.state(priority))).toEqual({ value: 'hi', selected: ['hi'] });
    expect(agent.selectOptions(priority, ['Urgent'])).toMatchObject({
      code: 'NOT_FOUND',
      error: expect.stringContaining('options: Low, High, Blocked') as unknown,
    });
    expect(failure(agent.selectOptions(priority, ['Blocked']))).toBe('DISABLED');
    expect(failure(agent.selectOptions(priority, ['lo', 'hi']))).toBe('INVALID_PARAMS');
    expect(value(agent.selectOptions(refOf('Tags'), ['a', 'b']))).toEqual(['a', 'b']);
    expect(failure(agent.selectOptions(refOf('Not a select'), ['a']))).toBe('INVALID_PARAMS');
  });

  it('drags with HTML5 drag events in order', () => {
    setPage(
      '<div draggable="true" role="listitem" aria-label="Card">Card</div><ul aria-label="Done"><li>x</li></ul>',
    );
    const events: string[] = [];
    for (const type of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']) {
      document.addEventListener(type, () => events.push(type));
    }
    value(agent.drag(refOf('Card'), refOf('list "Done"')));
    expect(events).toEqual(['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']);
  });
});

describe('observations and conditions', () => {
  it('collects live-region text and open dialogs', () => {
    setPage(`
      <div role="status">Order saved</div><div aria-live="off">ignored</div><div role="alert"></div>
      <div role="dialog" aria-label="Confirm">Sure?</div><div role="alertdialog" hidden>x</div>`);
    const live = value(agent.live());
    expect(Object.values(live.regions)).toEqual(['Order saved']);
    expect(live.dialogs).toEqual(['dialog "Confirm"']);
  });

  it('waits for the DOM to go quiet, up to a cap', async () => {
    const quietMs = value(await agent.quiet(10, 500));
    expect(quietMs).toBeLessThan(500);
    const timer = setInterval(() => {
      document.body.append('x');
    }, 2);
    const capped = value(await agent.quiet(50, 60));
    clearInterval(timer);
    expect(capped).toBeGreaterThanOrEqual(55);
  });

  it('waits longer while focus is in a field that shows suggestions after a debounce', async () => {
    setPage('<div role="combobox"><input id="item"></div><input id="plain">');
    (document.getElementById('plain') as HTMLInputElement).focus();
    expect(value(await agent.quiet(10, 500, 120))).toBeLessThan(100);
    (document.getElementById('item') as HTMLInputElement).focus();
    expect(value(await agent.quiet(10, 500, 120))).toBeGreaterThanOrEqual(115);
  });

  it('checks element states with what it saw', () => {
    setPage('<button>Go</button><button disabled>Go</button><button hidden>Stop</button>');
    const check = (state: 'attached' | 'detached' | 'visible' | 'hidden' | 'enabled', locator: Locator) =>
      value(agent.check({ kind: 'element', locator, state }));
    const go = { role: 'button', name: 'Go' };
    expect(check('visible', go)).toEqual({ met: true, observed: '2 match(es), 2 visible, 1 enabled' });
    expect(check('enabled', go).met).toBe(true);
    expect(check('attached', go).met).toBe(true);
    expect(check('detached', go)).toEqual({ met: false, observed: '2 matching element(s)' });
    expect(check('hidden', { css: 'button[hidden]' })).toEqual({
      met: true,
      observed: '1 match(es), 0 visible, 0 enabled',
    });
    expect(check('hidden', { text: 'Nope' })).toEqual({ met: true, observed: 'no matching element' });
    expect(value(agent.check({ kind: 'element', locator: { role: 'dialog' } })).met).toBe(false);
  });

  it('checks text, url and defers the rest to the engine', () => {
    setPage('<p>Order saved</p>');
    expect(value(agent.check({ kind: 'text', text: 'saved' }))).toEqual({
      met: true,
      observed: 'the text is shown',
    });
    expect(value(agent.check({ kind: 'text', text: 'saved', present: false })).met).toBe(false);
    // Names and values an agent sees in snapshots count as shown; hidden ones do not.
    setPage(
      '<button aria-label="Back">&lt;</button><input value="https://example.test"><b hidden title="Gone">x</b>',
    );
    expect(value(agent.check({ kind: 'text', text: 'Back' }))).toEqual({
      met: true,
      observed: 'the text is shown as a name or value',
    });
    expect(value(agent.check({ kind: 'text', text: 'example.test' })).met).toBe(true);
    expect(value(agent.check({ kind: 'text', text: 'Gone', present: false })).met).toBe(true);
    expect(value(agent.check({ kind: 'url', contains: document.URL.slice(0, 4) })).met).toBe(true);
    expect(value(agent.check({ kind: 'networkIdle' }))).toEqual({
      met: false,
      observed: 'networkIdle is checked outside the page',
    });
  });
});
