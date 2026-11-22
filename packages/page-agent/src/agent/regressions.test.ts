// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import { createAgent, type AgentResult, type PageAgent, type SnapshotResponse } from './agent.js';

/** Regression tests for P5 review findings: each reproduces the reported failure scenario. */

function value<T>(result: AgentResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

let agent: PageAgent;
const snap = (request: Parameters<PageAgent['snapshot']>[0] = {}): SnapshotResponse =>
  value(agent.snapshot(request));
/** Cached output must always equal a fresh rebuild. */
function expectCacheFresh(): string {
  const cached = snap().text;
  expect(cached).toBe(snap({ fresh: true }).text);
  return cached;
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  agent = createAgent(window, 'test');
});

describe('P5 review regressions', () => {
  it('never leaks a password through another element’s accessible name', () => {
    document.body.innerHTML = `
      <div id="row"><span>PIN</span><input type="password" value="hunter2"></div>
      <button aria-labelledby="row">x</button>
      <label>Secret <input type="password" value="hunter2"> code<input id="t" aria-label="t"></label>`;
    const text = snap().text;
    expect(text).not.toContain('hunter2');
    expect(text).toMatch(/button "PIN" \[e\d+\]/);
  });

  it('hides visibility:hidden elements but shows descendants that override it', () => {
    document.body.innerHTML = `
      <div style="visibility: hidden"><button>Ghost</button>
        <span style="visibility: visible"><button>Shown</button></span>Hidden text</div>`;
    const text = snap().text;
    expect(text).not.toContain('Ghost');
    expect(text).not.toContain('Hidden text');
    expect(text).toMatch(/button "Shown"/);
  });

  it('updates slotted content and picks up shadow roots attached after the first snapshot', () => {
    document.body.innerHTML = '<my-card><span>Old</span></my-card><x-late><b>light</b></x-late>';
    const card = document.querySelector('my-card')!;
    card.attachShadow({ mode: 'open' }).innerHTML = '<h2><slot></slot></h2>';
    expect(expectCacheFresh()).toMatch(/heading "Old"/);
    card.querySelector('span')!.textContent = 'New';
    expect(expectCacheFresh()).toMatch(/heading "New"/);
    const late = document.querySelector('x-late')!;
    late.attachShadow({ mode: 'open' }).innerHTML = '<button>Upgraded</button>';
    expect(expectCacheFresh()).toMatch(/button "Upgraded"/);
  });

  it('rebuilds descendants when any attribute that CSS may depend on changes', () => {
    document.head.innerHTML = '<style>[data-state=closed] .panel { display: none }</style>';
    document.body.innerHTML =
      '<div data-state="closed"><div class="panel"><button>Inside</button></div></div>';
    expect(expectCacheFresh()).not.toContain('Inside');
    document.querySelector('[data-state]')!.setAttribute('data-state', 'open');
    expect(expectCacheFresh()).toMatch(/button "Inside"/);
  });

  it('find sees names that changed through labels and skips controls that are now hidden', () => {
    document.body.innerHTML = '<label for="q">Search</label><input id="q">';
    snap();
    document.querySelector('label')!.textContent = 'Filter';
    const names = (name: string): number => value(agent.find({ role: 'textbox', name }, 5)).total;
    expect([names('Filter'), names('Search')]).toEqual([1, 0]);
    document.querySelector('input')!.style.display = 'none';
    expect(names('Filter')).toBe(0);
  });

  it('collapses long top-level lists too, with a hint, and never collapses the requested scope', () => {
    document.body.innerHTML = `<div>${'<div><button>b</button></div>'.repeat(50)}</div>`;
    const top = snap();
    expect(top.collapsed).toBe(30);
    expect(top.text).toContain('- … 30 more (find them, or snapshot a narrower root)');
    const scoped = snap({ root: { css: 'body > div' } });
    expect(scoped.collapsed).toBe(0);
    expect(scoped.lineCount).toBe(50);
  });

  it('shows an Electron webview as a separate target, not as a cross-origin frame of this page', () => {
    document.body.innerHTML = '<div role="dialog"><webview src="file:///plans/index.html"></webview></div>';
    // Electron renders a webview through an internal iframe in its shadow root.
    document.querySelector('webview')!.attachShadow({ mode: 'open' }).innerHTML = '<iframe></iframe>';
    const result = snap();
    expect(result.text).toMatch(/^ {2}- webview "" \[e\d+\] separate target \(see targets\)$/m);
    expect(result.text).not.toContain('iframe');
    expect(result.crossOriginFrames).toBe(0);
  });

  it('shows the choice of a combobox that is a button (Radix, shadcn selects)', () => {
    document.body.innerHTML =
      '<button type="button" role="combobox" aria-expanded="false"><span>Desktop + Mobile</span></button>';
    expect(snap().text).toMatch(/^- combobox "" \[e\d+\] expanded=false: "Desktop \+ Mobile"$/m);
  });

  it('never folds mixed page content at the top level, where nothing could expand it', () => {
    // An app shell whose wrappers flatten away: header controls, a form, cards, links, all side by side.
    const items = ['<button>Save</button>', '<input aria-label="Name">', '<a href="#r">Report</a>'];
    document.body.innerHTML = Array.from({ length: 45 }, (_, i) => items[i % 3] ?? '').join('');
    const top = snap();
    expect(top.collapsed).toBe(0);
    expect(top.lineCount).toBe(45);
  });

  it('keeps text placed directly in a shadow root', () => {
    document.body.innerHTML = '<x-total></x-total>';
    document.querySelector('x-total')!.attachShadow({ mode: 'open' }).innerHTML = 'Total: <b>5</b>';
    expect(snap().text.split('\n')).toEqual(['- text "Total:"', '- text "5"']);
  });

  it('rejects an ambiguous snapshot root instead of silently taking the first match', () => {
    document.body.innerHTML = '<ul aria-label="A"><li>1</li></ul><ul aria-label="B"><li>2</li></ul>';
    expect(agent.snapshot({ root: { role: 'list' } })).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
    expect(snap({ root: { role: 'list', nth: 1 } }).text).toMatch(/^- list "B"/);
  });
});

describe('editable tables', () => {
  it('shows the controls inside table cells, and keeps text-only cells on one line', () => {
    document.body.innerHTML = `
      <table><tr><th>Title</th><th>Count</th></tr>
      <tr><td><input aria-label="Title text"></td><td>2 <button>Remove</button></td></tr>
      <tr><td>Total</td><td>2</td></tr></table>`;
    const text = snap().text;
    expect(text).toMatch(/- textbox "Title text" \[e\d+\]/);
    expect(text).toMatch(/- button "Remove" \[e\d+\]/);
    expect(text).toMatch(/- cell "Total" \[e\d+\]$/m);
    expect(text).toMatch(/- columnheader "Title" \[e\d+\]$/m);
  });

  it('shows the textbox and suggestions of an ARIA 1.1 combobox wrapper, not a native select’s options', () => {
    document.body.innerHTML = `
      <div role="combobox" aria-expanded="true"><input aria-label="Title">
        <ul role="listbox"><li role="option">First suggestion</li></ul></div>
      <select aria-label="Size"><option>SMALL</option><option>LARGE</option></select>`;
    const text = snap().text;
    expect(text).toMatch(/- textbox "Title" \[e\d+\]/);
    expect(text).toMatch(/- option "First suggestion" \[e\d+\]/);
    expect(text).not.toMatch(/option "LARGE"/);
    // The wrapper shows no value of its own (its text is the suggestions); the textbox has the value.
    expect(text).toMatch(/^- combobox "" \[e\d+\] expanded=true$/m);
  });
});

describe('guessed names for unnamed controls', () => {
  it('names grid inputs by their column and icon buttons by tooltip, icon, test id or module class', () => {
    document.body.innerHTML = `
      <table>
        <tr><th>#</th><th>Title</th><th colspan="2">Range</th><th>Count</th></tr>
        <tr><td>1</td><td><input></td><td><input></td><td><input></td><td><input></td></tr>
      </table>
      <table><tr><td>Name</td><td>Share <select><option>%</option></select></td></tr>
        <tr><td><input></td><td><input></td></tr></table>
      <button data-tip="#help" class="helpButton___a1b2c"><svg></svg></button>
      <button data-tooltip="Settings"><svg></svg></button>
      <button><svg class="tabler-icon tabler-icon-dots-vertical"></svg></button>
      <button><svg data-testid="DeleteOutlinedIcon"></svg></button>
      <button class="addRowButtonWithoutText___x9y8z"><svg></svg></button>
      <button id="radix-5"><svg></svg></button>
      <button aria-label="Real name"><svg class="fa-solid fa-trash"></svg></button>`;
    const text = snap().text;
    expect(text).toMatch(/textbox "Title" \(guessed\) \[e\d+\]/);
    expect(text.match(/textbox "Range" \(guessed\)/g)).toHaveLength(2);
    expect(text).toMatch(/textbox "Count" \(guessed\) \[e\d+\]/);
    expect(text).toMatch(/button "Settings" \(guessed\)/);
    expect(text).toMatch(/button "dots vertical" \(guessed\)/);
    expect(text).toMatch(/button "delete outlined" \(guessed\)/);
    expect(text).toMatch(/button "add row" \(guessed\)/);
    expect(text).toMatch(/button "" \[e\d+\]/);
    expect(text).toMatch(/button "Real name" \[e\d+\]/);
    expect(text).not.toMatch(/"#help"/);
    // A table of plain cells: its first row without text entry heads the columns.
    expect(text).toMatch(/textbox "Name" \(guessed\)/);
    expect(text).toMatch(/textbox "Share" \(guessed\)/);
    expect(text).toMatch(/button "help" \(guessed\)/);
    // find matches the guesses too.
    const found = value(agent.find({ role: 'textbox', name: 'Count' }, 5));
    expect(found.matches).toHaveLength(1);
  });
});

describe('deltas of collapsed lists', () => {
  it('shows a change past the collapsed point of a long list, with its context', () => {
    const items = Array.from({ length: 40 }, (_, index) => `<li><button>Item ${index}</button></li>`);
    document.body.innerHTML = `<ul>${items.join('')}</ul>`;
    const first = snap();
    expect(first.text).toMatch(/… 20 more/);
    document.querySelectorAll('button')[35]!.textContent = 'Item 35 (saved)';
    const delta = snap({ mode: 'delta', since: first.cursor });
    expect(delta.kind).toBe('delta');
    // The changed item is revealed (shown as added) under its unchanged list.
    expect(delta.text).toMatch(/^\+ +- button "Item 35 \(saved\)"/m);
    expect(delta.text).toMatch(/^ {2}- list ""/m);
    expect(delta.text).not.toMatch(/Item 36|more/);
    // Revealed items stay shown, so the next delta is quiet when nothing changed.
    expect(snap({ mode: 'delta', since: delta.cursor }).kind).toBe('unchanged');
  });

  it('reveals only the changed branch of a collapsed item (a suggestion in a long form’s grid)', () => {
    const fields = Array.from({ length: 34 }, (_, index) => `<input aria-label="Field ${index}">`);
    const rows = Array.from({ length: 5 }, (_, index) => `<tr><td><button>Row ${index}</button></td></tr>`);
    document.body.innerHTML = `<form>${fields.join('')}<table>${rows.join('')}</table></form>`;
    const first = snap();
    expect(first.text).not.toMatch(/Row 0/);
    document
      .querySelectorAll('td')[3]!
      .insertAdjacentHTML('beforeend', '<ul role="listbox"><li role="option">First suggestion</li></ul>');
    const delta = snap({ mode: 'delta', since: first.cursor });
    expect(delta.kind).toBe('delta');
    expect(delta.text).toMatch(/\+ +- option "First suggestion"/);
    expect(delta.text).toMatch(/cell "Row 3 First suggestion"/);
    expect(delta.text).not.toMatch(/Row [0124]|Field 30/);
    expect(snap({ mode: 'delta', since: delta.cursor }).kind).toBe('unchanged');
  });
});

describe('find by text', () => {
  it('finds text split across lines or elements, innermost first, exact or not', () => {
    document.body.innerHTML = `
      <div id="share"><div id="pdf"><span>Download</span><br><span>PDF</span></div></div>
      <p>Print Report</p>`;
    const refsOf = (text: string, exact?: boolean) =>
      value(agent.find({ text, ...(exact === undefined ? {} : { exact }) }, 5)).matches.length;
    expect(refsOf('Download PDF')).toBe(1);
    expect(refsOf('download pdf')).toBe(1);
    expect(refsOf('Download PDF', true)).toBe(1);
    expect(refsOf('Download PD', true)).toBe(0);
    expect(refsOf('Print Report')).toBe(1);
    expect(refsOf('Nowhere')).toBe(0);
  });
});

describe('OSS app regressions', () => {
  /** Give an element a layout box (happy-dom has none) and the viewport its default size. */
  function place(el: Element, left: number, width: number): void {
    el.getBoundingClientRect = () => new DOMRect(left, 0, width, 400);
  }

  it('hides an off-canvas fixed drawer until it slides into view (Jitsi Meet settings)', () => {
    document.body.innerHTML = `
      <div id="drawer" style="position: fixed"><button>Back</button></div><button>Go</button>`;
    const drawer = document.getElementById('drawer')!;
    place(drawer, -360, 360);
    let text = expectCacheFresh();
    expect(text).not.toContain('Back');
    expect(text).toMatch(/button "Go"/);
    place(drawer, 0, 360);
    drawer.setAttribute('data-open', '');
    text = expectCacheFresh();
    expect(text).toMatch(/button "Back"/);
  });

  it('keeps a fixed box whose content overflows into view, and boxes without layout', () => {
    document.body.innerHTML = `
      <div id="tab" style="position: fixed"><button>Handle</button></div>
      <div style="position: fixed"><button>Unmeasured</button></div>`;
    const tab = document.getElementById('tab')!;
    place(tab, -300, 300);
    // Its content sticks out to the right (or is placed on its own).
    place(tab.querySelector('button')!, 0, 40);
    const text = snap().text;
    expect(text).toMatch(/button "Handle"/);
    expect(text).toMatch(/button "Unmeasured"/);
  });
  it('gives role-less clickable elements refs, named by their content (Zettlr’s menu bar)', () => {
    document.body.innerHTML = `
      <div id="menu"><div class="item" style="cursor: pointer"><span>File</span></div>
        <div class="item" style="cursor: pointer"><span>Edit</span><img src="x.png" alt="caret"></div></div>
      <div id="card" style="cursor: pointer">Card <button>Open</button></div>
      <div id="js">Run</div>
      <label style="cursor: pointer">Remember <input type="checkbox"></label>
      <p>Plain text</p>`;
    document.getElementById('js')!.onclick = () => undefined;
    const text = expectCacheFresh();
    expect(text).toMatch(/clickable "File" \[e\d+\]/);
    // Icons inside are part of the name, not separate lines; inherited cursors add nothing.
    expect(text).toMatch(/clickable "Edit caret" \[e\d+\]\n/);
    expect(text).not.toMatch(/- text "File"/);
    // A clickable holding other controls is a container.
    expect(text).toMatch(/clickable "Card Open" \[e\d+\]\n\s+- text "Card"\n\s+- button "Open"/);
    expect(text).toMatch(/clickable "Run" \[e\d+\]/);
    // The label's checkbox carries the ref; the label is not a second target.
    expect(text).not.toMatch(/clickable "Remember/);
    expect(text).toMatch(/checkbox "Remember" \[e\d+\]/);
    expect(text).toMatch(/- text "Plain text"/);
    const found = value(agent.find({ role: 'clickable', name: 'File' }, 5)).matches;
    expect(found.map((match) => match.line)).toEqual([expect.stringMatching(/^clickable "File" \[e\d+\]$/)]);
  });
});
