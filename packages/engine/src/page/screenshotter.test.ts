import { describe, expect, it } from 'vitest';

import type { TargetDescriptor } from '../ports/target-source.js';
import { AgentCode, FakeAgentPage } from '../testing/fake-agent-page.js';
import { AgentPool } from './agent-pool.js';
import { MAX_SCREENSHOT_BASE64, Screenshotter } from './screenshotter.js';

function setup(
  image = 'iVBORw==',
  box: () => unknown = () => ({ x: 10, y: 20, width: 30.4, height: 40, clipped: false }),
  devicePixels = 1280,
) {
  const page = new FakeAgentPage({ box });
  page.handle('Page.getLayoutMetrics', () => ({
    cssLayoutViewport: { pageX: 0, pageY: 500 },
    cssVisualViewport: { clientWidth: 1280, clientHeight: 800 },
    visualViewport: { clientWidth: devicePixels },
  }));
  page.handle('Page.captureScreenshot', () => ({ data: image }));
  const target: TargetDescriptor = {
    id: 'wc1',
    kind: 'window',
    title: '',
    url: '',
    focused: true,
    transport: page,
  };
  const shots = new Screenshotter(new AgentPool({ source: 'install()', version: 'test' }));
  return { page, take: (params: Parameters<Screenshotter['take']>[1]) => shots.take(target, params) };
}

describe('Screenshotter', () => {
  it('captures the viewport as PNG by default', async () => {
    const { page, take } = setup();
    expect((await take({})).data).toEqual({
      mimeType: 'image/png',
      width: 1280,
      height: 800,
      base64: 'iVBORw==',
    });
    expect(page.sent('Page.captureScreenshot')).toEqual([{ format: 'png' }]);
  });

  it('clips to an element in page coordinates (viewport box plus scroll)', async () => {
    const { page, take } = setup();
    const result = await take({ locator: { ref: 'e3' }, format: 'jpeg' });
    expect(result.data).toMatchObject({ mimeType: 'image/jpeg', width: 30, height: 40 });
    expect(page.sent('Page.captureScreenshot')).toEqual([
      { format: 'jpeg', quality: 80, clip: { x: 10, y: 520, width: 30.4, height: 40, scale: 1 } },
    ]);
  });

  it('reports the image size in device pixels on HiDPI screens', async () => {
    const { take } = setup(undefined, undefined, 2560);
    expect((await take({})).data).toMatchObject({ width: 2560, height: 1600 });
    expect((await take({ locator: { ref: 'e3' } })).data).toMatchObject({ width: 61, height: 80 });
  });

  it('notes when only part of the element is visible, and explains off-screen elements', async () => {
    const clipped = setup(undefined, () => ({ x: 0, y: 0, width: 10, height: 10, clipped: true }));
    expect((await clipped.take({ locator: { ref: 'e3' } })).limitations[0]?.message).toContain(
      'Only the visible part of the element is shown',
    );
    const away = setup(undefined, () => {
      throw new AgentCode('OFF_SCREEN', 'the element is outside the visible area');
    });
    await expect(away.take({ locator: { ref: 'e3' } })).rejects.toMatchObject({
      code: 'OFF_SCREEN',
      message: 'the element is outside the visible area',
      hint: expect.stringContaining('do not scroll the page') as unknown,
    });
    const gone = setup(undefined, () => {
      throw new AgentCode('STALE_REF', 'e3 no longer exists');
    });
    await expect(gone.take({ locator: { ref: 'e3' } })).rejects.toMatchObject({ code: 'STALE_REF' });
  });

  it('refuses images too large to return, with a hint', async () => {
    const { take } = setup('A'.repeat(MAX_SCREENSHOT_BASE64 + 4));
    await expect(take({ format: 'jpeg', quality: 50 })).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
      hint: expect.stringContaining('lower quality') as unknown,
    });
  });
});
