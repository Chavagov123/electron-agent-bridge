// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';

import { createAgent, type AgentResult } from '../agent/agent.js';
import { pageListensForClicks } from '../agent/clickable-query.js';
import { installClickTracking } from './clicks.js';

function value<T>(result: AgentResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

/**
 * One world stands in for both (happy-dom has no isolated worlds): what matters is the protocol —
 * the hook records listeners and answers the agent's query events, which the page never sees.
 */
beforeAll(() => {
  installClickTracking(window);
});

describe('click tracking', () => {
  it('answers for elements the page listens to for clicks, and only those', () => {
    document.body.innerHTML = '<div id="menu">File</div><div id="hover">Tip</div><div id="plain">Text</div>';
    const menu = document.getElementById('menu')!;
    const hover = document.getElementById('hover')!;
    let clicks = 0;
    menu.addEventListener('click', () => clicks++);
    hover.addEventListener('mouseenter', () => undefined);
    expect(pageListensForClicks(menu)).toBe(true);
    expect(pageListensForClicks(hover)).toBe(false);
    expect(pageListensForClicks(document.getElementById('plain')!)).toBe(false);
    // The wrapper delegates: the listener still works.
    menu.click();
    expect(clicks).toBe(1);
  });

  it('sees onclick properties and React click props', () => {
    document.body.innerHTML = '<div id="prop">A</div><div id="react">B</div><div id="react-hover">C</div>';
    document.getElementById('prop')!.onclick = () => undefined;
    Object.assign(document.getElementById('react')!, { __reactProps$abc: { onClick: () => undefined } });
    Object.assign(document.getElementById('react-hover')!, {
      __reactProps$abc: { onMouseEnter: () => undefined },
    });
    expect(pageListensForClicks(document.getElementById('prop')!)).toBe(true);
    expect(pageListensForClicks(document.getElementById('react')!)).toBe(true);
    expect(pageListensForClicks(document.getElementById('react-hover')!)).toBe(false);
  });

  it('gives refs to what the page listens to, not to wrappers of other controls (Zettlr’s menus)', () => {
    document.body.innerHTML = `
      <div id="bar"><div class="item">File</div><div class="item">Edit</div></div>
      <div id="wrap"><button>Save</button></div>
      <div id="menu"><div class="entry">New file</div><div class="entry">Open file</div></div>`;
    const listen = (selector: string) => {
      for (const el of document.querySelectorAll(selector)) el.addEventListener('click', () => undefined);
    };
    listen('.item');
    listen('#wrap');
    listen('#menu');
    listen('.entry');
    const text = value(createAgent(window, 'clicks').snapshot({})).text;
    expect(text).toMatch(/clickable "File" \[e\d+\]/);
    expect(text).toMatch(/clickable "Edit" \[e\d+\]/);
    // The wrapper around a button and the menu panel around its entries stay transparent.
    expect(text).toMatch(/^- button "Save" \[e\d+\]$/m);
    expect(text).not.toMatch(/clickable "Save"|clickable "New file Open file"/);
    expect(text).toMatch(/^- clickable "New file" \[e\d+\]$/m);
    expect(text).toMatch(/^- clickable "Open file" \[e\d+\]$/m);
  });

  it('forgets removed listeners, telling them apart by type and capture', () => {
    document.body.innerHTML = '<div id="item">Row</div>';
    const item = document.getElementById('item')!;
    const onDown = () => undefined;
    item.addEventListener('mousedown', onDown);
    item.addEventListener('mousedown', onDown, true);
    item.removeEventListener('mousedown', onDown);
    expect(pageListensForClicks(item)).toBe(true);
    item.removeEventListener('mousedown', onDown, { capture: true });
    expect(pageListensForClicks(item)).toBe(false);
  });

  it('answers for elements inside a shadow root', () => {
    document.body.innerHTML = '<x-menu id="host"></x-menu>';
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<div id="entry">Open</div>';
    const entry = root.getElementById('entry')!;
    entry.addEventListener('click', () => undefined);
    expect(pageListensForClicks(entry)).toBe(true);
  });

  it('finds a card’s button by name, not the card holding it', () => {
    document.body.innerHTML = '<div id="card" onclick="void 0">Item 1 <button>Delete</button></div>';
    const found = value(createAgent(window, 'clicks').find({ name: 'Delete' }, 10));
    expect(found.matches.map((match) => match.role)).toEqual(['button']);
  });

  it('keeps the queries away from the page’s own listeners', () => {
    document.body.innerHTML = '<div id="menu">File</div>';
    const menu = document.getElementById('menu')!;
    menu.addEventListener('click', () => undefined);
    const seen: string[] = [];
    window.addEventListener('electron-agent-bridge.v1.clickable', () => seen.push('window'), true);
    menu.addEventListener('electron-agent-bridge.v1.clickable', () => seen.push('element'));
    expect(pageListensForClicks(menu)).toBe(true);
    expect(seen).toEqual([]);
  });
});
