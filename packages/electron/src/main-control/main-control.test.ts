import { BridgeError } from '@electron-agent-bridge/core';
import { describe, expect, it } from 'vitest';

import { DialogStubs } from './dialog-stubs.js';
import { evaluateInMain } from './main-eval.js';
import { clickMenu, type MenuItemLike, type MenuLike } from './menu.js';
import { controlWindow, type WindowLike, type WindowsLike } from './windows.js';

function fakeWindow(id: number): WindowLike & { calls: string[] } {
  let bounds = { x: 0, y: 0, width: 800, height: 600 };
  let destroyed = false;
  const calls: string[] = [];
  const action = (name: string) => () => {
    calls.push(name);
  };
  return {
    id,
    calls,
    webContents: { id: id + 10 },
    getTitle: () => `window ${id}`,
    isVisible: () => true,
    isFocused: () => id === 1,
    isMinimized: () => false,
    isDestroyed: () => destroyed,
    getBounds: () => bounds,
    setBounds: (next) => {
      bounds = next;
    },
    focus: action('focus'),
    show: action('show'),
    hide: action('hide'),
    minimize: action('minimize'),
    maximize: action('maximize'),
    restore: action('restore'),
    close: () => {
      destroyed = true;
    },
  };
}

function fakeWindows(...windows: WindowLike[]): WindowsLike {
  return {
    getAllWindows: () => windows,
    fromId: (id) => windows.find((window) => window.id === id) ?? null,
    getFocusedWindow: () => windows.find((window) => window.isFocused()) ?? null,
  };
}

const code = (promise: Promise<unknown> | (() => unknown)) =>
  (typeof promise === 'function' ? Promise.resolve().then(promise) : promise).catch((error: unknown) =>
    error instanceof BridgeError ? error.code : error,
  );

describe('window control', () => {
  it('acts on a window, merges bounds, reports it gone after close, refuses unknown ids', async () => {
    const window = fakeWindow(1);
    const windows = fakeWindows(window);
    const shown = await controlWindow(windows, { window: 1, action: 'minimize' });
    expect(window.calls).toEqual(['minimize']);
    expect(shown.data.window).toMatchObject({ id: 1, target: 'wc11', title: 'window 1', focused: true });
    const moved = await controlWindow(windows, { window: 1, action: 'setBounds', bounds: { width: 300.6 } });
    expect(moved.data.window?.bounds).toEqual({ x: 0, y: 0, width: 301, height: 600 });
    expect(await code(controlWindow(windows, { window: 1, action: 'setBounds' }))).toBe('INVALID_PARAMS');
    expect((await controlWindow(windows, { window: 1, action: 'close' })).data).toEqual({});
    expect(await code(controlWindow(windows, { window: 1, action: 'focus' }))).toBe('NOT_FOUND');
    expect(await code(controlWindow(windows, { window: 9, action: 'focus' }))).toBe('NOT_FOUND');
  });
});

describe('menu click', () => {
  function item(label: string, extra: Partial<MenuItemLike> = {}): MenuItemLike & { clicks: unknown[][] } {
    const clicks: unknown[][] = [];
    return {
      label,
      enabled: true,
      visible: true,
      type: 'normal',
      clicks,
      click: (...args: unknown[]) => clicks.push(args),
      ...extra,
    };
  }
  const open = item('&Open...');
  const save = item('Save', { enabled: false });
  const secret = item('Secret', { visible: false });
  const recent = item('Recent', { type: 'submenu', submenu: { items: [], getMenuItemById: () => null } });
  const file = item('&File', {
    type: 'submenu',
    submenu: { items: [open, save, secret, recent], getMenuItemById: () => null },
  });
  const inLocked = item('X');
  const locked = item('Locked', {
    type: 'submenu',
    enabled: false,
    submenu: { items: [inLocked], getMenuItemById: () => null },
  });
  // Per-platform variants: the hidden one comes first.
  const macPrefs = item('Preferences', { visible: false });
  const prefs = item('Preferences');
  const edit = item('Edit', {
    type: 'submenu',
    submenu: { items: [macPrefs, prefs], getMenuItemById: () => null },
  });
  const menu: MenuLike = {
    items: [file, locked, edit],
    getMenuItemById: (id) => ({ 'file.open': open, 'locked.x': inLocked })[id] ?? null,
  };
  const windows = fakeWindows(fakeWindow(1));

  it('finds items by label path (mnemonics, ellipses and case ignored) or id, and clicks them like a user', () => {
    expect(clickMenu(menu, windows, { path: ['file', 'Open…'] }).data).toEqual({ label: '&Open...' });
    expect(clickMenu(menu, windows, { id: 'file.open' }).data.label).toBe('&Open...');
    expect(open.clicks).toHaveLength(2);
    expect(open.clicks[0]?.[0]).toEqual({ triggeredByAccelerator: false });
    expect(open.clicks[0]?.[1]).toMatchObject({ id: 1 });
  });

  it('prefers the usable one of items sharing a label', () => {
    clickMenu(menu, windows, { path: ['Edit', 'Preferences'] });
    expect([macPrefs.clicks.length, prefs.clicks.length]).toEqual([0, 1]);
  });

  it('refuses disabled, hidden, missing and non-clickable items with the reason', async () => {
    expect(await code(() => clickMenu(menu, windows, { id: 'locked.x' }))).toBe('DISABLED');
    expect(await code(() => clickMenu(menu, windows, { path: ['File', 'Save'] }))).toBe('DISABLED');
    expect(await code(() => clickMenu(menu, windows, { path: ['File', 'Secret'] }))).toBe('HIDDEN');
    expect(await code(() => clickMenu(menu, windows, { path: ['File', 'Recent'] }))).toBe('INVALID_PARAMS');
    expect(await code(() => clickMenu(menu, windows, { path: ['Locked', 'X'] }))).toBe('DISABLED');
    expect(await code(() => clickMenu(menu, windows, { path: ['View'] }))).toBe('NOT_FOUND');
    expect(await code(() => clickMenu(menu, windows, { id: 'nope' }))).toBe('NOT_FOUND');
    expect(await code(() => clickMenu(null, windows, { id: 'x' }))).toBe('NOT_FOUND');
    const error = await Promise.resolve()
      .then(() => clickMenu(menu, windows, { path: ['File', 'Close'] }))
      .catch((caught: unknown) => caught);
    expect((error as BridgeError).hint).toContain('"&Open..."');
  });
});

describe('dialog stubs', () => {
  function fakeDialog() {
    return {
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
      showOpenDialogSync: (): string[] | undefined => undefined,
      showSaveDialog: () => Promise.resolve({ canceled: true, filePath: '' }),
      showSaveDialogSync: () => '',
      showMessageBox: () => Promise.resolve({ response: 9, checkboxChecked: false }),
      showMessageBoxSync: () => 9,
    };
  }

  it('answers queued calls (async and sync variants) and then shows the real dialog again', async () => {
    const dialog = fakeDialog();
    const stubs = new DialogStubs(dialog);
    expect(
      stubs.stub({ method: 'showOpenDialog', response: { filePaths: ['/tmp/a.txt'] }, times: 2 }).data,
    ).toEqual({
      queued: 2,
    });
    expect(await dialog.showOpenDialog()).toEqual({ canceled: false, filePaths: ['/tmp/a.txt'] });
    expect(dialog.showOpenDialogSync()).toEqual(['/tmp/a.txt']);
    // Each queued answer is a copy: mutating one does not change the next.
    stubs.stub({ method: 'showOpenDialog', response: {}, times: 2 });
    const first = (await dialog.showOpenDialog()) as { filePaths: string[] };
    first.filePaths.push('/mutated');
    expect(await dialog.showOpenDialog()).toEqual({ canceled: false, filePaths: [] });
    expect(await dialog.showOpenDialog()).toEqual({ canceled: true, filePaths: [] });
    stubs.stub({ method: 'showSaveDialog', response: { filePath: '/tmp/out.csv' } });
    stubs.stub({ method: 'showSaveDialog', response: { canceled: true } });
    expect(dialog.showSaveDialogSync()).toBe('/tmp/out.csv');
    expect(await dialog.showSaveDialog()).toEqual({ canceled: true, filePath: '' });
    stubs.stub({ method: 'showMessageBox', response: { response: 1 } });
    expect(dialog.showMessageBoxSync()).toBe(1);
    stubs.stub({ method: 'showOpenDialog', response: { canceled: true } });
    expect(dialog.showOpenDialogSync()).toBeUndefined();
  });

  it('restores Electron’s functions and drops queued answers', async () => {
    const dialog = fakeDialog();
    const original = dialog.showMessageBox;
    const stubs = new DialogStubs(dialog);
    stubs.stub({ method: 'showMessageBox', response: { response: 2 }, times: 3 });
    stubs.restore();
    expect(dialog.showMessageBox).toBe(original);
    expect(await dialog.showMessageBox()).toMatchObject({ response: 9 });
    stubs.restore();
  });
});

describe('main eval', () => {
  const scope = { require: (id: string) => ({ required: id }), electron: { app: { getName: () => 'demo' } } };

  it('evaluates expressions and function bodies with require, electron and app in scope', async () => {
    expect((await evaluateInMain(scope, { expression: 'app.getName()' })).data).toEqual({
      type: 'string',
      value: 'demo',
      truncated: false,
    });
    expect(
      (await evaluateInMain(scope, { expression: 'const x = require("fs"); return [x.required, 2]' })).data,
    ).toEqual({
      type: 'array',
      value: ['fs', 2],
      truncated: false,
    });
    expect((await evaluateInMain(scope, { expression: 'Promise.resolve(null)' })).data.type).toBe('null');
    const secret = await evaluateInMain(scope, { expression: '({ user: "a", password: "p" })' });
    expect(secret.data.value).toEqual({ user: 'a', password: '[redacted]' });
    expect((await evaluateInMain(scope, { expression: '"x".repeat(5000)' })).data.truncated).toBe(true);
  });

  it('reports a throw as an error result, a syntax error as invalid params', async () => {
    const thrown = await evaluateInMain(scope, { expression: 'JSON.parse("{")' });
    expect(thrown.data).toMatchObject({ type: 'error', value: { name: 'SyntaxError' } });
    const own = await evaluateInMain(scope, { expression: '(() => { throw new TypeError("nope") })()' });
    const stack = String((own.data.value as { stack?: string }).stack);
    // From the error line through the expression's frame; none of the bridge's wrapper or frames.
    expect(stack).toMatch(/^TypeError: nope\n/);
    expect(stack).toContain('(main.eval)');
    expect(stack.split('\n').at(-1)).toContain('(main.eval)');
    expect(stack).not.toMatch(/main-eval|eval at|runBounded/);
    expect((await evaluateInMain(scope, { expression: 'throw "plain"' })).data.value).toEqual({
      message: 'plain',
    });
    expect(await code(evaluateInMain(scope, { expression: 'return )(' }))).toBe('INVALID_PARAMS');
  });

  it('runs code without await synchronously, so the whole run is bounded', async () => {
    const sync = await evaluateInMain(scope, {
      expression: 'let n = 0; for (let i = 0; i < 3; i++) n += i; return n',
    });
    expect(sync.data).toEqual({ type: 'number', value: 3, truncated: false });
    expect((await evaluateInMain(scope, { expression: 'await Promise.resolve(4)' })).data.value).toBe(4);
  });

  it('interrupts endless synchronous code and promises that never settle', async () => {
    expect(await code(evaluateInMain(scope, { expression: 'while (true) {}', timeoutMs: 50 }))).toBe(
      'TIMEOUT',
    );
    expect(await code(evaluateInMain(scope, { expression: 'new Promise(() => {})', timeoutMs: 50 }))).toBe(
      'TIMEOUT',
    );
  });
});
