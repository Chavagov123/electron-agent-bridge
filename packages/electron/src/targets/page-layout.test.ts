import { describe, expect, it } from 'vitest';

import { pageLayout, type ViewLike, type WindowLike } from './page-layout.js';

function view(id: number, bounds: [number, number, number, number], visible = true): ViewLike {
  const [x, y, width, height] = bounds;
  return { webContents: { id }, getBounds: () => ({ x, y, width, height }), getVisible: () => visible };
}

function window(children: ViewLike[], state: { visible?: boolean; minimized?: boolean } = {}): WindowLike {
  return {
    webContents: { id: 1 },
    contentView: { children },
    isVisible: () => state.visible ?? true,
    isMinimized: () => state.minimized ?? false,
    getContentSize: () => [800, 600],
  };
}

describe('pageLayout', () => {
  it('describes the window’s own page as the bottom of the stack', () => {
    expect(pageLayout(window([]), 1)).toEqual({ ownerContentsId: 1, visible: true, area: 480_000, stack: 0 });
    expect(pageLayout(window([], { minimized: true }), 1)?.visible).toBe(false);
  });

  it('places views in paint order, with the area they cover inside the window', () => {
    const win = window([view(2, [0, 0, 800, 40]), view(3, [0, 40, 800, 900])]);
    expect(pageLayout(win, 2)).toEqual({ ownerContentsId: 1, visible: true, area: 32_000, stack: 1 });
    // Clipped to the content area.
    expect(pageLayout(win, 3)).toMatchObject({ visible: true, area: 800 * 560, stack: 2 });
  });

  it('treats hidden views, hidden parents and zero-sized views as not visible, with no area', () => {
    const parent: ViewLike = { children: [view(5, [0, 0, 100, 100])], getVisible: () => false };
    const win = window([view(2, [0, 0, 800, 600], false), view(3, [0, 0, 0, 0]), parent]);
    expect(pageLayout(win, 2)).toMatchObject({ visible: false, area: 0 });
    expect(pageLayout(win, 3)).toMatchObject({ visible: false, area: 0 });
    expect(pageLayout(win, 5)).toMatchObject({ visible: false, area: 0 });
    // A hidden window keeps the area its views show in: they appear once it is shown.
    const shut = window([view(2, [0, 0, 800, 600])], { visible: false });
    expect(pageLayout(shut, 2)).toMatchObject({ visible: false, area: 480_000 });
  });

  it('knows nothing about pages the window does not host', () => {
    expect(pageLayout(window([view(2, [0, 0, 10, 10])]), 9)).toBeUndefined();
  });
});
