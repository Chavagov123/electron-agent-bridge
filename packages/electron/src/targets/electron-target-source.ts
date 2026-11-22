import type { TargetKind } from '@electron-agent-bridge/core';
import type {
  CdpTransport,
  ChildTarget,
  Disposable,
  TargetDescriptor,
  TargetSource,
} from '@electron-agent-bridge/engine';
import type { App, WebContents } from 'electron';

import { DebuggerSession } from '../cdp/debugger-session.js';
import type { PageLayout } from './page-layout.js';
import { targetNameOf } from './target-names.js';

interface Tracked {
  readonly contents: WebContents;
  readonly session: DebuggerSession;
  readonly watching: Disposable | undefined;
}

export interface ElectronTargetSourceDeps {
  readonly app: App;
  readonly allWebContents: () => WebContents[];
  /** Where `contents` sits in the window that owns it (`BrowserWindow.fromWebContents`). */
  readonly layoutOf: (contents: WebContents) => PageLayout | undefined;
  /** Called for every page as soon as it is tracked (log and network collectors); disposed when it is gone. */
  readonly onPage?: (targetId: string, transport: CdpTransport, contents: WebContents) => Disposable;
  /** Auto-attached children of the pages; workers and service workers are listed as targets too. */
  readonly children?: () => readonly ChildTarget[];
}

/** webContents types that are pages an agent can work with (never DevTools or background pages). */
const PAGE_TYPES = new Set<ReturnType<WebContents['getType']>>([
  'window',
  'browserView',
  'webview',
  'offscreen',
]);

/**
 * Tracks every page-like webContents (windows, views, webviews; never DevTools) and gives each a
 * {@link DebuggerSession} from creation on. Nothing is awaited here: the first navigation must not stall.
 */
export class ElectronTargetSource implements TargetSource {
  readonly #deps: ElectronTargetSourceDeps;
  readonly #tracked = new Map<number, Tracked>();
  readonly #onCreated = (_event: unknown, contents: WebContents): void => {
    this.#track(contents);
  };

  constructor(deps: ElectronTargetSourceDeps) {
    this.#deps = deps;
  }

  start(): void {
    this.#deps.app.on('web-contents-created', this.#onCreated);
    for (const contents of this.#deps.allWebContents()) this.#track(contents);
  }

  stop(): void {
    this.#deps.app.off('web-contents-created', this.#onCreated);
    for (const { session, watching } of this.#tracked.values()) {
      watching?.dispose();
      session.stop();
    }
    this.#tracked.clear();
  }

  list(): readonly TargetDescriptor[] {
    const devtools = new Set(this.#devToolsIds());
    return [...this.#tracked.values()]
      .filter(({ contents }) => !contents.isDestroyed() && !devtools.has(contents.id))
      .filter(({ contents }) => !contents.getURL().startsWith('devtools://'))
      .map(({ contents, session }) => this.#describe(contents, session))
      .concat(this.#workers());
  }

  /** Workers and service workers of the pages (frames belong to their page and are not listed). */
  #workers(): TargetDescriptor[] {
    return (this.#deps.children?.() ?? [])
      .filter((child) => child.kind !== 'frame' && child.transport.attached)
      .map((child) => ({
        id: child.id,
        kind: child.kind === 'frame' ? 'other' : child.kind,
        title: child.title,
        url: child.url,
        focused: false,
        transport: child.transport,
        ownerId: child.parentId,
      }));
  }

  #track(contents: WebContents): void {
    if (this.#tracked.has(contents.id) || !PAGE_TYPES.has(contents.getType())) return;
    const session = new DebuggerSession(contents);
    session.start();
    let watching: Disposable | undefined;
    try {
      watching = this.#deps.onPage?.(`wc${contents.id}`, session.transport, contents);
    } catch {
      // Logs and network of this page are not collected; the page itself is tracked as usual.
    }
    this.#tracked.set(contents.id, { contents, session, watching });
    contents.once('destroyed', () => {
      this.#tracked.delete(contents.id);
      watching?.dispose();
      session.stop();
    });
  }

  /**
   * `WebContentsView` pages report type `window` too; a page is a window only when it is its owning
   * window's own page. Everything else embedded in a window is a view.
   */
  #kindOf(contents: WebContents, layout: PageLayout | undefined): TargetKind {
    if (contents.getType() === 'webview') return 'webview';
    if (contents.getType() === 'offscreen') return 'offscreen';
    return layout?.ownerContentsId === contents.id ? 'window' : 'view';
  }

  #describe(contents: WebContents, session: DebuggerSession): TargetDescriptor {
    const layout = this.#layoutOf(contents);
    const base: TargetDescriptor = {
      id: `wc${contents.id}`,
      kind: this.#kindOf(contents, layout),
      title: contents.getTitle(),
      url: contents.getURL(),
      focused: contents.isFocused(),
      loading: contents.isLoading(),
      transport: session.transport,
      ...(layout === undefined
        ? {}
        : {
            visible: layout.visible,
            area: layout.area,
            stack: layout.stack,
            ownerId: `wc${layout.ownerContentsId}`,
          }),
    };
    const nameHint = targetNameOf(contents);
    return nameHint === undefined ? base : { ...base, nameHint };
  }

  /** Layout is best effort: a window being torn down must not break listing. */
  #layoutOf(contents: WebContents): PageLayout | undefined {
    try {
      return this.#deps.layoutOf(contents);
    } catch {
      return undefined;
    }
  }

  #devToolsIds(): number[] {
    return [...this.#tracked.values()]
      .map(({ contents }) => (contents.isDestroyed() ? undefined : contents.devToolsWebContents?.id))
      .filter((id): id is number => id !== undefined);
  }
}
