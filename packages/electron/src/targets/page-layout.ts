/** Where a page sits in its window: lets the bridge tell an agent which pages are on screen. */
export interface PageLayout {
  /** webContents id of the owning window's own page. */
  readonly ownerContentsId: number;
  /** Window shown and not minimized, the page's view and its ancestors visible, with a size. */
  readonly visible: boolean;
  /**
   * Pixels of the window's content area the page shows in (0 when its view or an ancestor is hidden),
   * whether or not the window itself is shown at the moment.
   */
  readonly area: number;
  /** Paint order in the window: 0 is the window's own page, higher is drawn above. */
  readonly stack: number;
}

interface Size {
  readonly width: number;
  readonly height: number;
}
interface Rect extends Size {
  readonly x: number;
  readonly y: number;
}

/** The parts of Electron's `View` / `WebContentsView` read here. */
export interface ViewLike {
  readonly children?: readonly ViewLike[];
  readonly webContents?: { readonly id: number };
  getBounds?: () => Rect;
  getVisible?: () => boolean;
}

/** The parts of Electron's `BrowserWindow` read here. */
export interface WindowLike {
  readonly webContents: { readonly id: number };
  readonly contentView?: ViewLike;
  isVisible: () => boolean;
  isMinimized: () => boolean;
  getContentSize: () => number[];
}

/** The layout of the page `contentsId` in `window`, or undefined when the window does not host it. */
export function pageLayout(window: WindowLike, contentsId: number): PageLayout | undefined {
  const [width = 0, height = 0] = window.getContentSize();
  const shown = window.isVisible() && !window.isMinimized();
  const owner = window.webContents.id;
  if (contentsId === owner) return { ownerContentsId: owner, visible: shown, area: width * height, stack: 0 };
  const views = paintOrder(window.contentView, true);
  const index = views.findIndex((entry) => entry.view.webContents?.id === contentsId);
  const found = views[index];
  if (found === undefined) return undefined;
  const area = found.visible ? overlap(found.view.getBounds?.(), { width, height }) : 0;
  // The root content view is entry 0, at the level of the window's own page.
  return { ownerContentsId: owner, visible: shown && area > 0, area, stack: index };
}

/** Views in the order they are painted (children after, i.e. above, their parent and earlier siblings). */
function paintOrder(view: ViewLike | undefined, visible: boolean): { view: ViewLike; visible: boolean }[] {
  if (view === undefined) return [];
  const here = visible && view.getVisible?.() !== false;
  return [{ view, visible: here }, ...(view.children ?? []).flatMap((child) => paintOrder(child, here))];
}

function overlap(bounds: Rect | undefined, content: Size): number {
  if (bounds === undefined) return 0;
  const width = Math.min(bounds.x + bounds.width, content.width) - Math.max(bounds.x, 0);
  const height = Math.min(bounds.y + bounds.height, content.height) - Math.max(bounds.y, 0);
  return width > 0 && height > 0 ? width * height : 0;
}
