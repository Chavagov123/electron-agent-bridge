import { BridgeError, ok, type Envelope, type MethodData, type MethodInput } from '@eab/core';

type WindowInfo = MethodData<'app.info'>['windows'][number];
type Bounds = WindowInfo['bounds'];

/** The parts of `BrowserWindow` the bridge uses (faked in tests). */
export interface WindowLike {
  readonly id: number;
  readonly webContents: { readonly id: number };
  getTitle(): string;
  isVisible(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  isDestroyed(): boolean;
  getBounds(): Bounds;
  setBounds(bounds: Bounds): void;
  focus(): void;
  show(): void;
  hide(): void;
  minimize(): void;
  maximize(): void;
  restore(): void;
  close(): void;
}

export interface WindowsLike {
  getAllWindows(): WindowLike[];
  fromId(id: number): WindowLike | null;
  getFocusedWindow(): WindowLike | null;
}

/** What `app.info` and `window.control` report about one window. */
export function windowInfo(window: WindowLike): WindowInfo {
  return {
    id: window.id,
    target: `wc${window.webContents.id}`,
    title: window.getTitle(),
    visible: window.isVisible(),
    focused: window.isFocused(),
    minimized: window.isMinimized(),
    bounds: window.getBounds(),
  };
}

/** `window.control`: one action on one window; reports the window afterwards (absent once closed). */
export async function controlWindow(
  windows: WindowsLike,
  input: MethodInput<'window.control'>,
): Promise<Envelope<MethodData<'window.control'>>> {
  const window = windows.fromId(input.window);
  if (!window || window.isDestroyed()) {
    throw new BridgeError('NOT_FOUND', `no window ${input.window}`, {
      hint: 'List the windows with app action=info.',
    });
  }
  const { action } = input;
  if (action === 'setBounds') {
    if (input.bounds === undefined) {
      throw new BridgeError('INVALID_PARAMS', 'setBounds needs `bounds` (any of x, y, width, height)');
    }
    const current = window.getBounds();
    const { x = current.x, y = current.y, width = current.width, height = current.height } = input.bounds;
    // Electron takes whole pixels only.
    window.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    });
  } else if (action === 'close') {
    window.close();
    // Closing completes after the app's `close` handlers ran (they may prevent it).
    await new Promise((resolve) => setTimeout(resolve, 50));
  } else {
    window[action]();
  }
  return ok(window.isDestroyed() ? {} : { window: windowInfo(window) });
}
