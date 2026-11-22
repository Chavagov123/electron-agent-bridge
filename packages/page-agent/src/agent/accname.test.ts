// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import { MAX_NAME, accessibleName } from './accname.js';
import { isHidden, roleOf, statesOf, valueOf } from './semantics.js';

function el(selector: string): Element {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('roleOf', () => {
  it.each([
    ['<a id="x" href="#">a</a>', 'link'],
    ['<a id="x">a</a>', undefined],
    ['<h3 id="x">h</h3>', 'heading'],
    ['<img id="x" alt="">', undefined],
    ['<img id="x" alt="Logo">', 'img'],
    ['<select id="x"></select>', 'combobox'],
    ['<select id="x" size="4"></select>', 'listbox'],
    ['<input id="x" type="hidden">', undefined],
    ['<input id="x" type="email">', 'textbox'],
    ['<input id="x" type="checkbox">', 'checkbox'],
    ['<input id="x" list="l">', 'combobox'],
    ['<section id="x" aria-label="S"></section>', 'region'],
    ['<section id="x"></section>', undefined],
    ['<div id="x" role="Tab Button"></div>', 'tab'],
    ['<button id="x" role="presentation">b</button>', undefined],
    ['<div id="x" contenteditable="true"></div>', 'textbox'],
    ['<div id="x" contenteditable="false"></div>', undefined],
    ['<summary id="x">s</summary>', 'button'],
  ])('%s → %s', (html, role) => {
    document.body.innerHTML = html;
    expect(roleOf(el('#x'))).toBe(role);
  });
});

describe('states and values', () => {
  it('reports states in a fixed order from DOM properties and ARIA', () => {
    document.body.innerHTML = `
      <input id="a" type="checkbox" checked disabled required>
      <div id="b" role="checkbox" aria-checked="mixed"></div>
      <button id="c" aria-pressed="true" aria-expanded="false" aria-current="page">x</button>
      <h1 id="d" aria-level="4">t</h1>
      <details id="e" open><summary>s</summary></details>
      <input id="f" readonly>`;
    expect(statesOf(el('#a'), 'checkbox')).toEqual(['disabled', 'checked', 'required']);
    expect(statesOf(el('#b'), 'checkbox')).toEqual(['checked=mixed']);
    expect(statesOf(el('#c'), 'button')).toEqual(['pressed', 'expanded=false', 'current']);
    expect(statesOf(el('#d'), 'heading')).toEqual(['level=4']);
    expect(statesOf(el('#e'), 'group')).toEqual(['expanded=true']);
    expect(statesOf(el('#f'), 'textbox')).toEqual(['readonly']);
    const input = el('#a') as HTMLInputElement;
    input.indeterminate = true;
    expect(statesOf(input, 'checkbox')).toContain('checked=mixed');
  });

  it('reads values, never passwords', () => {
    document.body.innerHTML = `
      <input id="t" value="Ann"><input id="p" type="password" value="hunter2">
      <select id="s"><option>A</option><option selected>B</option></select>
      <div id="c" role="textbox" contenteditable="true">Draft</div><input id="e" value="">`;
    expect(valueOf(el('#t'), 'textbox')).toEqual({ value: 'Ann' });
    expect(valueOf(el('#p'), 'textbox')).toEqual({ redacted: true });
    expect(valueOf(el('#s'), 'combobox')).toEqual({ value: 'B' });
    expect(valueOf(el('#c'), 'textbox')).toEqual({ value: 'Draft' });
    expect(valueOf(el('#e'), 'textbox')).toBeUndefined();
    expect(valueOf(el('#t'), 'button')).toBeUndefined();
  });

  it('treats hidden, aria-hidden and non-rendering elements as hidden', () => {
    document.body.innerHTML =
      '<p id="a" hidden>x</p><p id="b" aria-hidden="true">x</p><script id="c"></script><p id="d">x</p>';
    expect(['#a', '#b', '#c', '#d'].map((selector) => isHidden(el(selector)))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});

describe('accessibleName', () => {
  it('prefers aria-labelledby, then aria-label, then native labels, then content, then title', () => {
    document.body.innerHTML = `
      <span id="l1">First</span><span id="l2" hidden>Second</span>
      <button id="a" aria-labelledby="l1 l2" aria-label="ignored">content</button>
      <button id="b" aria-label="  Labelled  ">content</button>
      <label for="c">Customer</label><input id="c" title="t" placeholder="p">
      <button id="d">Save <b>now</b><span hidden>secret</span></button>
      <input id="e" title="Tip" placeholder="Hint">
      <input id="f" placeholder="Hint">`;
    expect(accessibleName(el('#a'))).toBe('First Second');
    expect(accessibleName(el('#b'))).toBe('Labelled');
    expect(accessibleName(el('#c'))).toBe('Customer');
    expect(accessibleName(el('#d'))).toBe('Save now');
    expect(accessibleName(el('#e'))).toBe('Tip');
    expect(accessibleName(el('#f'))).toBe('Hint');
  });

  it('handles wrapping labels with embedded controls, buttons, images and captions', () => {
    document.body.innerHTML = `
      <label><input id="a" type="checkbox"> Gift wrap</label>
      <label>Qty <input id="b" type="number" value="3"> items</label>
      <input id="c" type="submit"><input id="d" type="reset"><input id="e" type="button" value="Go">
      <input id="f" type="image"><img id="g" alt="Logo">
      <fieldset id="h"><legend>Delivery</legend></fieldset>
      <table id="i"><caption>Orders</caption></table>
      <figure id="j"><figcaption>Chart</figcaption></figure>
      <a id="k" href="#"><img alt="Home icon"> Home</a>`;
    expect(accessibleName(el('#a'))).toBe('Gift wrap');
    expect(accessibleName(el('#b'))).toBe('Qty items');
    expect(['#c', '#d', '#e', '#f', '#g'].map((s) => accessibleName(el(s)))).toEqual([
      'Submit',
      'Reset',
      'Go',
      'Submit',
      'Logo',
    ]);
    expect(['#h', '#i', '#j', '#k'].map((s) => accessibleName(el(s)))).toEqual([
      'Delivery',
      'Orders',
      'Chart',
      'Home icon Home',
    ]);
  });

  it('uses embedded control values when an ancestor names from content, and survives cycles', () => {
    document.body.innerHTML = `
      <span id="n">Size <select><option>Large</option></select></span>
      <button id="a" aria-labelledby="n">x</button>
      <div id="x" aria-labelledby="y">X</div><div id="y" aria-labelledby="x">Y</div>`;
    expect(accessibleName(el('#a'))).toBe('Size Large');
    expect(accessibleName(el('#x'))).toBe('Y');
  });

  it('clips long names', () => {
    document.body.innerHTML = `<button id="a">${'word '.repeat(50)}</button>`;
    const name = accessibleName(el('#a'));
    expect(name.length).toBe(MAX_NAME);
    expect(name.endsWith('…')).toBe(true);
  });
});
