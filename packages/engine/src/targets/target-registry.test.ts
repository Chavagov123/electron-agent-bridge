import { describe, expect, it } from 'vitest';

import type { TargetDescriptor } from '../ports/target-source.js';
import { FakeCdpTransport } from '../testing/fake-cdp-transport.js';
import { baseName, slug, uniqueName, urlStem } from './naming.js';
import { TargetRegistry } from './target-registry.js';

function target(id: string, overrides: Partial<TargetDescriptor> = {}): TargetDescriptor {
  return {
    id,
    kind: 'window',
    title: '',
    url: '',
    focused: false,
    transport: new FakeCdpTransport(),
    ...overrides,
  };
}

describe('naming', () => {
  it.each([
    ['file:///C:/app/settings.html', 'settings'],
    ['file:///home/u/app/index.html?tab=2#x', 'index'],
    ['https://example.com/orders/42', '42'],
    ['https://example.com/', 'example.com'],
    ['app://bundle/views/editor.html', 'editor'],
    ['plain/path/report.pdf', 'report'],
  ])('urlStem(%j) = %j', (url, stem) => {
    expect(urlStem(url)).toBe(stem);
  });

  it('slugs to lowercase dashes, bounded, and rejects empty results', () => {
    expect(slug('  My Settings — Window!  ')).toBe('my-settings-window');
    expect(slug('x'.repeat(100))).toHaveLength(40);
    expect(slug('—!—')).toBeUndefined();
  });

  it('prefers explicit, then distinctive file, then title, then generic file, then kind', () => {
    const base = { kind: 'window', url: 'file:///a/index.html', title: '' } as const;
    expect(baseName({ ...base, nameHint: 'Main Editor' })).toBe('main-editor');
    expect(baseName({ ...base, url: 'file:///a/settings.html', title: 'Prefs' })).toBe('settings');
    expect(baseName({ ...base, title: 'Order Desk' })).toBe('order-desk');
    expect(baseName(base)).toBe('index');
    // Before a page sets a title, Chromium shows a file's name as its title: that is not one.
    expect(baseName({ ...base, url: 'file:///a/Index.html', title: 'Index.html' })).toBe('index');
    const dialog = 'data:text/html;charset=UTF-8,%3C!doctype%20html%3E';
    expect(baseName({ ...base, url: dialog, title: 'Confirm delete' })).toBe('confirm-delete');
    expect(baseName({ ...base, url: dialog, title: dialog })).toBe(base.kind);
    expect(baseName({ ...base, url: 'file:///' })).toBe('window');
    expect(baseName({ ...base, url: 'about:blank', title: 'x' })).toBeUndefined();
    expect(baseName({ ...base, url: '' })).toBeUndefined();
  });

  it('suffixes duplicates', () => {
    expect(uniqueName('main', new Set())).toBe('main');
    expect(uniqueName('main', new Set(['main', 'main-2']))).toBe('main-3');
  });
});

describe('TargetRegistry', () => {
  it('assigns unique names that stay stable when pages retitle or navigate', () => {
    let pages = [
      target('wc1', { url: 'file:///a/index.html', title: 'Orders' }),
      target('wc2', { url: 'file:///a/index.html', title: 'Orders' }),
    ];
    const registry = new TargetRegistry({ list: () => pages });
    expect(registry.list().map((t) => t.name)).toEqual(['orders', 'orders-2']);
    pages = pages.map((page) => ({ ...page, title: 'Changed', url: 'file:///a/other.html' }));
    expect(registry.list().map((t) => t.name)).toEqual(['orders', 'orders-2']);
  });

  it('waits for something to name a blank page after, using its id meanwhile', () => {
    let pages = [target('wc5', { url: 'about:blank' })];
    const registry = new TargetRegistry({ list: () => pages });
    expect(registry.list()[0]?.name).toBe('wc5');
    pages = [target('wc5', { url: 'file:///a/editor.html' })];
    expect(registry.list()[0]?.name).toBe('editor');
  });

  it("lets the app's explicit name replace a derived one and releases names of closed targets", () => {
    let pages = [target('wc1', { url: 'file:///a/settings.html' })];
    const registry = new TargetRegistry({ list: () => pages });
    expect(registry.list()[0]?.name).toBe('settings');
    pages = [target('wc1', { url: 'file:///a/settings.html', nameHint: 'prefs' })];
    expect(registry.list()[0]?.name).toBe('prefs');
    pages = [target('wc9', { url: 'file:///a/prefs.html' })];
    expect(registry.list()[0]?.name).toBe('prefs');
  });

  it('gives an explicit name precedence over a derived one another page already has', () => {
    let pages = [
      target('wc1', { url: 'file:///a/settings.html' }),
      target('wc2', { url: 'file:///a/index.html', title: 'Other' }),
    ];
    const registry = new TargetRegistry({ list: () => pages });
    expect(registry.list().map((t) => t.name)).toEqual(['settings', 'other']);
    pages = [pages[0]!, target('wc2', { url: 'file:///a/index.html', title: 'Other', nameHint: 'settings' })];
    expect(registry.list().map((t) => t.name)).toEqual(['settings-2', 'settings']);
    expect(registry.resolve('settings').id).toBe('wc2');
  });

  it('follows a renamed explicit name', () => {
    let pages = [target('wc1', { url: 'file:///a/x.html', nameHint: 'one' })];
    const registry = new TargetRegistry({ list: () => pages });
    expect(registry.list()[0]?.name).toBe('one');
    pages = [target('wc1', { url: 'file:///a/x.html', nameHint: 'two' })];
    expect(registry.list()[0]?.name).toBe('two');
  });

  it('does not freeze a derived name while the page is still loading', () => {
    let pages = [target('wc1', { url: 'file:///a/index.html', title: '', loading: true })];
    const registry = new TargetRegistry({ list: () => pages });
    expect(registry.list()[0]?.name).toBe('index');
    pages = [target('wc1', { url: 'file:///a/index.html', title: 'Order Desk', loading: false })];
    expect(registry.list()[0]?.name).toBe('order-desk');
    pages = [target('wc1', { url: 'file:///a/index.html', title: 'Renamed', loading: false })];
    expect(registry.list()[0]?.name).toBe('order-desk');
  });

  it('ignores a title that is just the URL', () => {
    const url = 'file:///C:/app/index.html';
    const registry = new TargetRegistry({ list: () => [target('wc1', { url, title: url })] });
    expect(registry.list()[0]?.name).toBe('index');
  });

  it('never hands out a name equal to another live target id', () => {
    const registry = new TargetRegistry({
      list: () => [target('wc5', { url: 'about:blank' }), target('wc7', { url: 'file:///a/wc5.html' })],
    });
    const [blank, other] = registry.list();
    expect(blank?.name).toBe('wc5');
    expect(other?.name).toBe('wc5-2');
  });

  it('resolves by id or case-insensitive name and lists both in the error hint', () => {
    const registry = new TargetRegistry({ list: () => [target('wc1', { url: 'file:///a/settings.html' })] });
    expect(registry.resolve('wc1').name).toBe('settings');
    expect(registry.resolve('Settings').id).toBe('wc1');
    expect(() => registry.resolve('nope')).toThrow(
      expect.objectContaining({ hint: 'Known targets: settings (wc1).' }),
    );
  });
});
