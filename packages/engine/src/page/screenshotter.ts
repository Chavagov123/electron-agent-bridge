import {
  BridgeError,
  LIMITATION_CODES,
  ok,
  type Envelope,
  type MethodData,
  type MethodInput,
} from '@eab/core';
import type { ElementBox } from '@eab/page-agent';
import { z } from 'zod';

import type { TargetDescriptor } from '../ports/target-source.js';
import type { AgentPool } from './agent-pool.js';

/** Inline images larger than this (base64 chars) are refused with a hint (≈ 7.5 MB of image). */
export const MAX_SCREENSHOT_BASE64 = 10_000_000;

const LayoutMetrics = z.object({
  cssLayoutViewport: z.object({ pageX: z.number(), pageY: z.number() }),
  cssVisualViewport: z.object({ clientWidth: z.number(), clientHeight: z.number() }),
  /** Device pixels (deprecated by CDP, but the only place the device pixel ratio shows). */
  visualViewport: z.object({ clientWidth: z.number() }).optional(),
});
const Captured = z.object({ data: z.string() });

type ScreenshotParams = Omit<MethodInput<'screenshot.take'>, 'target'>;

/**
 * `screenshot.take`: the visible page, or the visible part of one element. Nothing is scrolled (an
 * observer may take screenshots); sizes are those of the image, in device pixels.
 */
export class Screenshotter {
  readonly #pool: AgentPool;

  constructor(pool: AgentPool) {
    this.#pool = pool;
  }

  async take(
    target: TargetDescriptor,
    params: ScreenshotParams,
  ): Promise<Envelope<MethodData<'screenshot.take'>>> {
    const client = this.#pool.clientFor(target);
    const box =
      params.locator === undefined
        ? undefined
        : await client.invoke<ElementBox>('box', [params.locator]).catch((error: unknown) => {
            throw withScrollHint(error);
          });
    const metrics = LayoutMetrics.parse(await client.transport.send('Page.getLayoutMetrics'));
    const format = params.format ?? 'png';
    const captured = Captured.parse(
      await client.transport.send('Page.captureScreenshot', {
        format,
        ...(format === 'jpeg' ? { quality: params.quality ?? 80 } : {}),
        ...(box === undefined ? {} : { clip: clipOf(box, metrics) }),
      }),
    );
    if (captured.data.length > MAX_SCREENSHOT_BASE64) {
      throw new BridgeError('BUDGET_EXCEEDED', 'the screenshot is too large to return', {
        hint: 'Take a screenshot of one element (locator), or use format jpeg with a lower quality.',
      });
    }
    const data = {
      mimeType: format === 'png' ? ('image/png' as const) : ('image/jpeg' as const),
      ...imageSize(box, metrics),
      base64: captured.data,
    };
    if (box?.clipped !== true) return ok(data);
    return ok(data, [
      {
        code: LIMITATION_CODES.partial,
        message:
          'Only the visible part of the element is shown; scroll it into view (act scroll) to see more.',
      },
    ]);
  }
}

type Metrics = z.infer<typeof LayoutMetrics>;

/** Clip coordinates are page coordinates: the viewport box plus the scroll position. */
function clipOf(box: ElementBox, metrics: Metrics): object {
  const { pageX, pageY } = metrics.cssLayoutViewport;
  return { x: box.x + pageX, y: box.y + pageY, width: box.width, height: box.height, scale: 1 };
}

/** The image's size: CSS pixels times the device pixel ratio. */
function imageSize(box: ElementBox | undefined, metrics: Metrics): { width: number; height: number } {
  const css = metrics.cssVisualViewport;
  const ratio = (metrics.visualViewport?.clientWidth ?? 0) / css.clientWidth || 1;
  return {
    width: Math.round((box?.width ?? css.clientWidth) * ratio),
    height: Math.round((box?.height ?? css.clientHeight) * ratio),
  };
}

/** Off-screen elements are not scrolled to: say how to bring them into view. */
function withScrollHint(error: unknown): BridgeError {
  const failure = BridgeError.from(error);
  if (failure.code !== 'OFF_SCREEN') return failure;
  return new BridgeError('OFF_SCREEN', failure.message.replace(/^page agent: /, ''), {
    hint: 'Screenshots do not scroll the page: scroll the element into view first (act scroll with its locator).',
  });
}
