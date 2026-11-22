// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import { createAgent, type PageAgent } from './agent.js';

const PRESENT = { enabled: false, hitTest: false, visible: false };
let agent: PageAgent;

beforeEach(() => {
  document.body.innerHTML = '<button id="a">Save</button>';
  agent = createAgent(window, 'test');
});

const target = async (name: string) => agent.actionTarget({ role: 'button', name, exact: true }, PRESENT);

describe('locator memo', () => {
  it('finds the same element again while the DOM is unchanged', async () => {
    const first = await target('Save');
    const again = await target('Save');
    expect(again).toEqual(first);
  });

  it('never returns an element the DOM changed away from', async () => {
    expect((await target('Save')).ok).toBe(true);
    document
      .querySelector('#a')
      ?.replaceWith(Object.assign(document.createElement('button'), { textContent: 'Saved' }));
    expect(await target('Save')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect((await target('Saved')).ok).toBe(true);
    const button = document.querySelector('button');
    if (button) button.textContent = 'Save';
    expect(await target('Saved')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect((await target('Save')).ok).toBe(true);
  });

  it('reports a second match once one appears', async () => {
    expect((await target('Save')).ok).toBe(true);
    document.body.append(Object.assign(document.createElement('button'), { textContent: 'Save' }));
    expect(await target('Save')).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
  });
});
