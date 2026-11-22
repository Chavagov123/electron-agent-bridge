import type { Locator } from '@electron-agent-bridge/core';

import { resolveOne, type ActionabilityContext } from './actionability.js';
import { AgentFailure } from './failure.js';
import { isHidden } from './semantics.js';

/** The visible part of an element in top-level viewport CSS pixels (screenshots). */
export interface ElementBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Part of the element is outside the visible area (scrolled away, or larger than the window). */
  readonly clipped: boolean;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where an element is visible, without scrolling anything (observers may take screenshots too, and
 * must not move the page under the controlling client): its box clipped to its frame's viewport, then
 * to each enclosing frame's viewport, up to the top window. OFF_SCREEN when nothing of it is visible.
 */
export function elementBox(locator: Locator, context: ActionabilityContext): ElementBox {
  const { el } = resolveOne(locator, context);
  if (isHidden(el)) throw new AgentFailure('HIDDEN', 'the element is not visible');
  const own = el.getBoundingClientRect();
  if (own.width === 0 || own.height === 0) throw new AgentFailure('HIDDEN', 'the element has no size');
  let rect: Rect = { left: own.left, top: own.top, right: own.right, bottom: own.bottom };
  for (let win = el.ownerDocument.defaultView; win;) {
    rect = intersect(rect, { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight });
    const frame = win.frameElement;
    if (!frame) break;
    const outer = frame.getBoundingClientRect();
    const dx = outer.left + frame.clientLeft;
    const dy = outer.top + frame.clientTop;
    rect = { left: rect.left + dx, top: rect.top + dy, right: rect.right + dx, bottom: rect.bottom + dy };
    win = frame.ownerDocument.defaultView;
  }
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  if (width <= 0 || height <= 0) {
    throw new AgentFailure('OFF_SCREEN', 'the element is outside the visible area');
  }
  const clipped = width < own.width - 0.5 || height < own.height - 0.5;
  return { x: rect.left, y: rect.top, width, height, clipped };
}

function intersect(a: Rect, b: Rect): Rect {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}
