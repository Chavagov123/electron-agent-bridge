import { BridgeError } from '@eab/core';
import { describe, expect, it } from 'vitest';

import type { TargetDescriptor } from '../ports/target-source.js';
import { FakeCdpTransport } from '../testing/fake-cdp-transport.js';
import { resolveTarget } from './resolve-target.js';

function target(id: string, overrides: Partial<TargetDescriptor> = {}): TargetDescriptor {
  return {
    id,
    kind: 'window',
    title: id,
    url: 'file:///x',
    focused: false,
    transport: new FakeCdpTransport(),
    ...overrides,
  };
}

describe('resolveTarget', () => {
  it('returns the selected target by id', () => {
    expect(resolveTarget([target('w1'), target('w2')], 'w2').id).toBe('w2');
  });

  it('reports known ids when the selector matches nothing', () => {
    try {
      resolveTarget([target('w1')], 'w9');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).code).toBe('NOT_FOUND');
      expect((error as BridgeError).hint).toContain('w1');
    }
  });

  it('defaults to the focused window, then the first window, then anything', () => {
    const webview = target('v1', { kind: 'webview', focused: true });
    expect(resolveTarget([webview, target('w1'), target('w2', { focused: true })]).id).toBe('w2');
    expect(resolveTarget([webview, target('w1')]).id).toBe('w1');
    expect(resolveTarget([webview]).id).toBe('v1');
  });

  it('prefers a visible window over a hidden one', () => {
    expect(resolveTarget([target('w1', { visible: false }), target('w2', { visible: true })]).id).toBe('w2');
  });

  it('defaults to the topmost visible view covering most of the window (apps built from views)', () => {
    const shell = target('w1', { focused: true, visible: true, area: 1000, stack: 0, ownerId: 'w1' });
    const view = (id: string, overrides: Partial<TargetDescriptor>): TargetDescriptor =>
      target(id, { kind: 'view', visible: true, ownerId: 'w1', ...overrides });
    const content = view('v1', { area: 900, stack: 1 });
    const menu = view('v2', { area: 0, stack: 2, visible: false });
    const bar = view('v3', { area: 50, stack: 3 });
    const other = view('v4', { area: 900, stack: 4, ownerId: 'w9' });
    expect(resolveTarget([shell, content, menu, bar, other]).id).toBe('v1');
    // A window not shown yet (apps that show it once loaded) still defaults to its covering view.
    const hidden = { visible: false };
    expect(
      resolveTarget([
        { ...shell, ...hidden },
        { ...content, ...hidden },
      ]).id,
    ).toBe('v1');
    // Nothing covering: the window's own page.
    expect(resolveTarget([shell, bar]).id).toBe('w1');
    // Focus inside a view selects its window.
    const away = target('w0', { visible: true, area: 1000, ownerId: 'w0' });
    const focusedView = view('v5', { area: 950, stack: 1, focused: true });
    expect(resolveTarget([away, { ...shell, focused: false }, focusedView]).id).toBe('v5');
  });

  it('fails clearly when there are no targets', () => {
    expect(() => resolveTarget([])).toThrow(/no pages/);
  });
});
