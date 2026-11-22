// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgent } from './agent.js';
import type { FindContext } from './find.js';
import { RECORD_BINDING, cssPath, locatorFor, startRecording, type RecordedAction } from './record.js';
import { RefTable } from './refs.js';
import { TreeBuilder, type TreeNode } from './tree.js';

let context: FindContext;
let recorded: RecordedAction[];
let stop: () => void;

function contextFor(doc: Document): FindContext {
  const refs = new RefTable();
  const builder = new TreeBuilder(refs, doc);
  return {
    doc,
    refs,
    nodes: (): readonly TreeNode[] => builder.build(doc.body, true),
    head: (node) => (node.live ? builder.head(node) : node.head),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  recorded = [];
  context = contextFor(document);
  stop = startRecording(
    window,
    context,
    (payload) => recorded.push(JSON.parse(payload) as RecordedAction),
    () => true,
  );
});

afterEach(() => {
  stop();
});

const actions = () => recorded.map((record) => record.action);
const el = (selector: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
};

describe('recording user actions', () => {
  it('records clicks on what the user meant, with role and exact name', () => {
    document.body.innerHTML =
      '<button id="save"><span class="icon">💾</span> Save</button><a href="#x">Help</a>';
    el('.icon').click();
    el('a').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, detail: 1 }));
    expect(actions()).toEqual([
      { type: 'click', locator: { role: 'button', name: '💾 Save', exact: true } },
      { type: 'click', locator: { role: 'link', name: 'Help', exact: true }, modifiers: ['Control'] },
    ]);
    expect(recorded[0]?.url).toMatch(/^http/);
  });

  it('adds nth when the name is shared, and falls back to text or CSS', () => {
    document.body.innerHTML =
      '<ul><li><button>Delete</button></li><li><button>Delete</button></li></ul><div id="plain">x</div><div><div></div><div class="z"></div></div>';
    el('li:nth-of-type(2) button').click();
    expect(actions()[0]).toEqual({
      type: 'click',
      locator: { role: 'button', name: 'Delete', exact: true, nth: 1 },
    });
    expect(locatorFor(el('#plain'), context)).toEqual({ text: 'x', exact: true });
    expect(cssPath(el('.z'))).toBe('body > div:nth-of-type(2) > div:nth-of-type(2)');
    el('#plain').textContent = '';
    expect(locatorFor(el('#plain'), context)).toEqual({ css: '#plain' });
  });

  it('records the control pressed when an overlay it opened made the click land on the page', () => {
    document.body.innerHTML = '<div id="app"><div role="combobox" aria-label="Period">This Month</div></div>';
    const combobox = el('[role=combobox]');
    combobox.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    // The select opened its menu: the page behind it is aria-hidden, and a backdrop is under the
    // pointer, so the click goes to the common ancestor.
    el('#app').setAttribute('aria-hidden', 'true');
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div role="listbox"><div role="option">This Month</div></div>',
    );
    document.documentElement.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    document.documentElement.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(actions()).toEqual([
      { type: 'click', locator: { role: 'combobox', name: 'Period', exact: true } },
    ]);
  });

  it('forgets a press that never became a click (a drag), so a later click is its own', () => {
    document.body.innerHTML = '<div id="card"><button>Open</button><span id="pad">pad</span></div>';
    el('button').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    el('button').dispatchEvent(new Event('dragstart', { bubbles: true }));
    el('#card').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(actions()[0]?.type).toBe('click');
    expect(actions()[0]).not.toMatchObject({ locator: { role: 'button', name: 'Open' } });
  });

  it('finds a generic clickable by its text, never by a role other tools cannot match', () => {
    document.body.innerHTML = '<div role="generic" id="reload" onclick="void 0">Reload</div>';
    expect(locatorFor(el('#reload'), context)).toEqual({ text: 'Reload', exact: true });
  });

  it('records a field’s final value once, never a password, and keys that are commands', () => {
    document.body.innerHTML =
      '<label>Email <input id="email"></label><label>Password <input id="pw" type="password"></label>';
    const email = el('#email') as HTMLInputElement;
    email.value = 'a@b.test';
    email.dispatchEvent(new Event('change', { bubbles: true }));
    email.dispatchEvent(new Event('change', { bubbles: true }));
    email.focus();
    email.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    email.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const pw = el('#pw') as HTMLInputElement;
    pw.value = 'hunter2';
    pw.focus();
    pw.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    expect(actions()).toEqual([
      { type: 'fill', locator: { role: 'textbox', name: 'Email', exact: true }, value: 'a@b.test' },
      { type: 'press', key: 'Enter', locator: { role: 'textbox', name: 'Email', exact: true } },
      { type: 'fill', locator: { role: 'textbox', name: 'Password', exact: true }, value: '' },
      { type: 'press', key: 'Control+S', locator: { role: 'textbox', name: 'Password', exact: true } },
    ]);
    expect(recorded[2]?.secret).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain('hunter2');
  });

  it('records checkboxes and selects by their state, not the click that changed them', () => {
    document.body.innerHTML =
      '<label><input id="c" type="checkbox"> Remember</label><select id="s" aria-label="Size"><option value="s">S</option><option value="m">M</option></select>';
    // The label click toggles the box, which fires change: one `check`, no click.
    el('label').click();
    expect((el('#c') as HTMLInputElement).checked).toBe(true);
    const select = el('#s') as HTMLSelectElement;
    select.value = 'm';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(actions()).toEqual([
      { type: 'check', locator: { role: 'checkbox', name: 'Remember', exact: true } },
      { type: 'select', locator: { role: 'combobox', name: 'Size', exact: true }, values: ['m'] },
    ]);
  });

  it('records a contenteditable editor’s text when focus leaves it, and bounds what it sends', () => {
    document.body.innerHTML =
      '<div id="ed" contenteditable="true" role="textbox" aria-label="Message"></div><input id="long" aria-label="Long">';
    const editor = el('#ed');
    editor.textContent = 'Hello there';
    editor.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    const long = el('#long') as HTMLInputElement;
    long.value = 'y'.repeat(20_000);
    long.dispatchEvent(new Event('change', { bubbles: true }));
    expect(actions()[0]).toEqual({
      type: 'fill',
      locator: { role: 'textbox', name: 'Message', exact: true },
      value: 'Hello there',
    });
    expect((actions()[1] as { value: string }).value).toHaveLength(8_000);
    let deep = '<span>leaf</span>';
    for (let index = 0; index < 80; index++) deep = `<div><div></div>${deep}</div>`;
    document.body.innerHTML = deep;
    const css = locatorFor(el('span'), context);
    expect((css.css ?? '').length).toBeLessThanOrEqual(500);
  });

  it('ignores untrusted events and stops when asked', () => {
    stop();
    const untrusted: RecordedAction[] = [];
    stop = startRecording(window, context, (payload) =>
      untrusted.push(JSON.parse(payload) as RecordedAction),
    );
    document.body.innerHTML = '<button>Go</button>';
    el('button').click();
    stop();
    expect(untrusted).toEqual([]);
  });
});

describe('agent recording API', () => {
  it('starts only when the engine’s binding exists, and gives refs a stable locator', () => {
    const agent = createAgent(window, 'test');
    expect(agent.recordStart()).toEqual({ ok: true, value: false });
    const calls: string[] = [];
    (globalThis as Record<string, unknown>)[RECORD_BINDING] = (payload: string) => calls.push(payload);
    try {
      expect(agent.recordStart()).toEqual({ ok: true, value: true });
      expect(agent.recordStop()).toEqual({ ok: true, value: true });
      expect(agent.recordStop()).toEqual({ ok: true, value: false });
    } finally {
      Reflect.deleteProperty(globalThis, RECORD_BINDING);
    }
    document.body.innerHTML = '<button>Pay</button>';
    const snapshot = agent.snapshot({});
    const ref = snapshot.ok ? /\[(e\d+)\]/.exec(snapshot.value.text)?.[1] : undefined;
    expect(agent.locatorFor(ref ?? 'e0')).toEqual({
      ok: true,
      value: { role: 'button', name: 'Pay', exact: true },
    });
    expect(agent.locatorFor('e999')).toMatchObject({ ok: false, code: 'STALE_REF' });
  });
});
