import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { ok } from '@eab/core';
import type { App } from 'electron';

import type { MethodHandlers } from '../control/rpc-session.js';
import { DialogStubs } from './dialog-stubs.js';
import { evaluateInMain } from './main-eval.js';
import { clickMenu, type MenuLike } from './menu.js';
import { controlWindow, windowInfo, type WindowsLike } from './windows.js';

/** The Electron main-process objects main control works on. */
export interface MainControlHost {
  readonly app: App;
  readonly windows: WindowsLike;
  readonly applicationMenu: () => MenuLike | null;
  readonly dialog: object;
  /** The `electron` module, in scope for `main.eval`. */
  readonly electron: unknown;
  readonly electronVersion: string;
}

export interface MainControl {
  readonly handlers: Pick<
    MethodHandlers,
    'app.info' | 'window.control' | 'menu.click' | 'dialog.stub' | 'main.eval'
  >;
  /** Undo what automation changed in the main process (dialog stubs). */
  restore(): void;
}

/** Handlers of FR9: app info, windows, application menu, dialog stubs and main-process evaluation. */
export function createMainControl(host: MainControlHost): MainControl {
  const dialogs = new DialogStubs(host.dialog);
  // Resolved per call: early in a launch (injected before the app is set up) the app path is still empty.
  const appRequire = (id: string): unknown =>
    createRequire(resolve(host.app.getAppPath() || process.cwd(), 'package.json'))(id);
  return {
    handlers: {
      'app.info': () =>
        ok({
          name: host.app.getName(),
          version: host.app.getVersion(),
          electron: host.electronVersion,
          chrome: process.versions.chrome,
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
          isPackaged: host.app.isPackaged,
          pid: process.pid,
          windows: host.windows
            .getAllWindows()
            .filter((window) => !window.isDestroyed())
            .map(windowInfo),
        }),
      'window.control': (input) => controlWindow(host.windows, input),
      'menu.click': (input) => clickMenu(host.applicationMenu(), host.windows, input),
      'dialog.stub': (input) => dialogs.stub(input),
      'main.eval': (input) => evaluateInMain({ require: appRequire, electron: host.electron }, input),
    },
    restore: () => {
      dialogs.restore();
    },
  };
}
