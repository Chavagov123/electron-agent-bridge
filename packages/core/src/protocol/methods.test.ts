import { describe, expect, it } from 'vitest';

import { Methods, isMethodName, methodsAllowed, type MethodName } from './methods.js';

/** One valid params example per method: the table must accept it (keeps schemas honest as they evolve). */
const VALID_PARAMS: Record<MethodName, unknown> = {
  'session.auth': { token: 't', protocolVersion: '0.1.0', client: { name: 'c', version: '1' } },
  'session.reset': {},
  'targets.list': {},
  'snapshot.take': {
    target: 'wc1',
    mode: 'delta',
    since: 'c1',
    root: { ref: 'e3' },
    depth: 3,
    fidelity: 'ax',
  },
  'dom.find': { locator: { role: 'button', name: 'Save', exact: true }, limit: 5 },
  'screenshot.take': { format: 'jpeg', quality: 80, locator: { ref: 'f2:e7' } },
  'action.run': {
    actions: [
      { type: 'click', locator: { ref: 'e1' }, modifiers: ['Shift'] },
      { type: 'fill', locator: { css: '#q' }, value: 'x' },
      { type: 'fillForm', fields: [{ locator: { ref: 'e2' }, value: true }] },
      { type: 'press', key: 'Control+S' },
      { type: 'select', locator: { ref: 'e4' }, values: ['a'] },
      { type: 'upload', locator: { ref: 'e5' }, files: ['/tmp/a.txt'] },
      { type: 'drag', from: { ref: 'e6' }, to: { ref: 'e7' } },
      { type: 'scroll', deltaY: 300 },
    ],
    timeoutMs: 1_000,
  },
  'wait.for': {
    condition: { kind: 'element', locator: { text: 'Saved' }, state: 'visible' },
    timeoutMs: 5_000,
  },
  'ipc.query': { since: 10, limit: 50, channel: 'orders:*', kind: 'invoke' },
  'logs.query': { source: 'renderer', minLevel: 'warn', contains: 'x' },
  'network.query': { url: '*/api/*', failedOnly: true },
  'state.read': { store: 'main', path: 'orders.items[0]', maxDepth: 3 },
  'state.dispatch': { action: { type: 'orders/add' } },
  'app.info': {},
  'window.control': { window: 1, action: 'setBounds', bounds: { width: 800 } },
  'menu.click': { path: ['File', 'Open…'] },
  'dialog.stub': { method: 'showOpenDialog', response: { canceled: false, filePaths: ['/a'] } },
  'main.eval': { expression: 'app.getName()' },
  'state.component': { locator: { ref: 'e3' }, path: 'hooks[0]', component: 1 },
  'record.start': {},
  'record.stop': {},
  'record.events': { since: 3, limit: 50 },
};

describe('Methods', () => {
  it('recognises only declared methods, not prototype keys', () => {
    expect(isMethodName('targets.list')).toBe(true);
    expect(isMethodName('toString')).toBe(false);
    expect(isMethodName('nope')).toBe(false);
  });

  it.each(Object.keys(Methods) as MethodName[])('%s accepts its documented example', (method) => {
    const result = Methods[method].params.safeParse(VALID_PARAMS[method]);
    expect(result.error).toBeUndefined();
  });

  it.each([
    ['session.auth', { token: '', protocolVersion: '0.1.0', client: { name: 'c', version: '1' } }],
    ['dom.find', { locator: {} }],
    ['dom.find', { locator: { ref: 'button-1' } }],
    ['action.run', { actions: [] }],
    ['action.run', { actions: [{ type: 'teleport' }] }],
    ['action.run', { actions: [{ type: 'click', locator: { ref: 'e1' }, clickCount: 9 }] }],
    ['wait.for', { condition: { kind: 'expression', expression: 'true' } }],
    ['ipc.query', { limit: 10_000 }],
    ['menu.click', {}],
    ['menu.click', { id: 'a', path: ['b'] }],
    ['main.eval', { expression: '' }],
  ] as const)('%s rejects %j', (method, params) => {
    expect(Methods[method].params.safeParse(params).success).toBe(false);
  });

  it('accepts an omitted snapshot target', () => {
    expect(Methods['snapshot.take'].params.parse({})).toEqual({});
  });

  it('keeps eval-tier methods out of the default capability ceiling', () => {
    const defaults = methodsAllowed(['observe', 'interact']);
    expect(defaults).toContain('action.run');
    expect(defaults).not.toContain('main.eval');
    expect(defaults).not.toContain('dialog.stub');
    expect(methodsAllowed(['observe'])).not.toContain('action.run');
    expect(methodsAllowed(['observe', 'interact', 'eval'])).toHaveLength(Object.keys(Methods).length);
  });
});
