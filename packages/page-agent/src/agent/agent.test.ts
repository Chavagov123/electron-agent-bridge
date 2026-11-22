// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import { createAgent, type AgentResult, type PageAgent, type SnapshotResponse } from './agent.js';

function value<T>(result: AgentResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

/** Flush MutationObserver-free state: the agent reads pending records itself, so nothing to wait for. */
function snap(agent: PageAgent, request: Parameters<PageAgent['snapshot']>[0] = {}): SnapshotResponse {
  return value(agent.snapshot(request));
}

let agent: PageAgent;

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Fixture';
  agent = createAgent(window, 'test');
});

function setPage(html: string): void {
  document.body.innerHTML = html;
}

describe('snapshot', () => {
  it('renders roles, names, refs, states and values; hoists plain containers', () => {
    setPage(`
      <nav aria-label="Primary"><a href="#a">Home</a></nav>
      <div><div><h1>Orders</h1></div></div>
      <form aria-label="New order">
        <label for="q">Quantity</label><input id="q" type="number" value="3">
        <label><input type="checkbox" checked> Gift</label>
        <input type="password" aria-label="Pin" value="1234">
        <button disabled>Save</button>
      </form>
      <p>Plain <b>text</b></p>`);
    const result = snap(agent);
    expect(result.kind).toBe('full');
    expect(result.text.split('\n')).toEqual([
      '- navigation "Primary" [e1]',
      '  - link "Home" [e2]',
      '- heading "Orders" [e3] level=1',
      '- form "New order" [e4]',
      '  - text "Quantity"',
      '  - spinbutton "Quantity" [e5]: "3"',
      '  - checkbox "Gift" [e6] checked',
      '  - text "Gift"',
      '  - textbox "Pin" [e7]: (redacted)',
      '  - button "Save" [e8] disabled',
      '- text "Plain"',
      '- text "text"',
    ]);
    expect(result.text).not.toContain('1234');
    expect(result).toMatchObject({ lineCount: 12, truncated: false, title: 'Fixture', crossOriginFrames: 0 });
  });

  it('keeps refs stable across snapshots and reflects live control state without mutations', () => {
    setPage('<input aria-label="Name"><button>Go</button>');
    const first = snap(agent).text;
    document.querySelector('input')!.value = 'Ann';
    const second = snap(agent).text;
    expect(first).toBe('- textbox "Name" [e1]\n- button "Go" [e2]');
    expect(second).toBe('- textbox "Name" [e1]: "Ann"\n- button "Go" [e2]');
  });

  it('scopes to a root, limits depth and bounds lines', () => {
    setPage(
      '<nav aria-label="N"><ul><li><a href="#">One</a></li><li><a href="#">Two</a></li></ul></nav><main><h2>Body</h2></main>',
    );
    const listRef = /list "" \[(e\d+)\]/.exec(snap(agent).text)?.[1];
    expect(snap(agent, { root: { ref: listRef ?? '' } }).text.split('\n')).toEqual([
      `- list "" [${listRef ?? ''}]`,
      '  - listitem "" [e3]',
      '    - link "One" [e4]',
      '  - listitem "" [e5]',
      '    - link "Two" [e6]',
    ]);
    // depth counts levels below the top: one level of children, then a summary.
    expect(snap(agent, { depth: 1 }).text.split('\n')).toEqual([
      '- navigation "N" [e1]',
      '  - list "" [e2]',
      '    - … 2 more below',
      '- main "" [e7]',
      '  - heading "Body" [e8] level=2',
    ]);
    expect(snap(agent, { maxLines: 2 })).toMatchObject({ lineCount: 2, truncated: true });
    expect(agent.snapshot({ root: { ref: 'e999' } })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('collapses long lists unless the list itself is expanded', () => {
    setPage(`<ul aria-label="Items">${'<li>row</li>'.repeat(50)}</ul>`);
    const collapsed = snap(agent);
    expect(collapsed.collapsed).toBe(30);
    expect(collapsed.text).toContain('  - … 30 more [expand e1]');
    // The list, 20 items with their text, and the summary line.
    expect(collapsed.lineCount).toBe(42);
    const expanded = snap(agent, { root: { ref: 'e1' } });
    expect(expanded.collapsed).toBe(0);
    expect(expanded.lineCount).toBe(101);
  });

  it('walks open shadow roots and slotted content', () => {
    setPage('<x-card><span slot="title">Hello</span></x-card>');
    const host = document.querySelector('x-card')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<h2><slot name="title"></slot></h2><button>Inside</button>';
    expect(snap(agent).text.split('\n')).toEqual([
      '- heading "Hello" [e1] level=2',
      '- button "Inside" [e2]',
    ]);
  });

  it('applies accessibility-tree name overrides by ref', () => {
    setPage('<button>Go</button>');
    expect(snap(agent, { names: { e1: 'Go now' } }).text).toBe('- button "Go now" [e1]');
  });
});

describe('deltas', () => {
  it('reports unchanged, added, changed and removed lines with ancestor context', () => {
    setPage('<ul aria-label="L"><li id="a">A</li><li id="b">B</li></ul><button>Save</button>');
    const first = snap(agent);
    expect(snap(agent, { mode: 'delta', since: first.cursor })).toMatchObject({
      kind: 'unchanged',
      text: '',
    });

    const base = snap(agent);
    document.querySelector('#b')!.textContent = 'B2';
    document.querySelector('ul')!.insertAdjacentHTML('beforeend', '<li>C</li>');
    const delta = snap(agent, { mode: 'delta', since: base.cursor });
    expect(delta.kind).toBe('delta');
    expect(delta.text.split('\n')).toEqual([
      '  - list "L" [e1]',
      '    - listitem "" [e3]',
      '+     - text "B2"',
      '+   - listitem "" [e5]',
      '+     - text "C"',
      '-     - text "B"',
    ]);
  });

  it('falls back to a full snapshot for unknown cursors, other scopes, or large changes', () => {
    setPage('<button>A</button>');
    const base = snap(agent);
    expect(snap(agent, { mode: 'delta', since: 'nope.1' })).toMatchObject({
      kind: 'full',
      fullBecause: 'unknown-cursor',
    });
    expect(snap(agent, { mode: 'delta', since: base.cursor, depth: 3 })).toMatchObject({
      kind: 'full',
      fullBecause: 'scope-changed',
    });
    const before = snap(agent);
    setPage('<button>X</button><button>Y</button>');
    expect(snap(agent, { mode: 'delta', since: before.cursor })).toMatchObject({
      kind: 'full',
      fullBecause: 'too-many-changes',
    });
  });

  it('remembers only the last few cursors', () => {
    setPage('<button>A</button>');
    const oldest = snap(agent);
    for (let index = 0; index < 4; index++) snap(agent);
    expect(snap(agent, { mode: 'delta', since: oldest.cursor }).fullBecause).toBe('unknown-cursor');
  });
});

describe('find', () => {
  beforeEach(() => {
    setPage(`
      <button>Save order</button><button>Save draft</button><button disabled>Archive</button>
      <p class="note">Total is <b>42</b></p><a href="#x">Save</a>`);
  });

  it('matches role + name (substring or exact), text, css and nth', () => {
    const names = (locator: Parameters<PageAgent['find']>[0]): string[] =>
      value(agent.find(locator, 10)).matches.map((match) => `${match.role}:${match.name}`);
    expect(names({ role: 'button', name: 'save' })).toEqual(['button:Save order', 'button:Save draft']);
    expect(names({ role: 'link', name: 'Save', exact: true })).toEqual(['link:Save']);
    expect(names({ text: 'Total is' })).toEqual(['generic:Total is 42']);
    expect(names({ css: 'button[disabled]' })).toEqual(['button:Archive']);
    expect(names({ role: 'button', nth: 1 })).toEqual(['button:Save draft']);
    expect(names({ role: 'button', nth: 7 })).toEqual([]);
  });

  it('returns refs usable as snapshot roots and element handles, and limits results', () => {
    const result = value(agent.find({ role: 'button' }, 2));
    expect(result.total).toBe(3);
    expect(result.matches).toHaveLength(2);
    const [first] = result.matches;
    expect(first?.line).toBe(`button "Save order" [${first?.ref ?? ''}]`);
    expect(agent.element(first?.ref ?? '')?.textContent).toBe('Save order');
    expect(agent.element('e999')).toBeNull();
    expect(agent.element('garbage')).toBeNull();
  });

  it('reports invalid CSS as invalid params', () => {
    expect(agent.find({ css: '[[' }, 5)).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
  });

  it('lists refs of the page in document order', () => {
    expect(value(agent.refs(10))).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(value(agent.refs(2))).toEqual(['e1', 'e2']);
    expect(value(agent.refs(10, { ref: 'e3' }))).toEqual(['e3']);
    expect(agent.refs(10, { role: 'button' })).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
  });
});
