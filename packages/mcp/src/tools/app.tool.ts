import { BridgeError, type MethodData } from '@eab/core';
import { z } from 'zod';

import { renderLimitations, untrusted } from '../render/text.js';
import { definedOf } from './defined.js';
import { defineTool } from './tool.js';

type WindowInfo = MethodData<'app.info'>['windows'][number];

export const appTool = defineTool({
  name: 'app',
  requiresFeature: 'mainControl',
  description:
    'The app’s main process: action=info (versions, platform, windows); action=window controls a ' +
    'window (focus/show/hide/minimize/maximize/restore/close/setBounds); action=menu clicks an ' +
    'application-menu item by id or label path.',
  inputSchema: {
    action: z.enum(['info', 'window', 'menu']),
    window: z.number().int().optional().describe('Window id (from info) for action=window.'),
    windowAction: z
      .enum(['focus', 'show', 'hide', 'minimize', 'maximize', 'restore', 'close', 'setBounds'])
      .optional(),
    bounds: z
      .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
      .partial()
      .optional(),
    menuId: z.string().max(256).optional(),
    menuPath: z.array(z.string().max(256)).min(1).max(10).optional().describe('e.g. ["File", "Open…"]'),
  },
  async handle(input, { sessions }) {
    const client = await sessions.current();
    switch (input.action) {
      case 'info': {
        const result = await client.call('app.info', {});
        const info = result.data;
        const head =
          `${info.name} ${info.version} (pid ${info.pid}, ${info.isPackaged ? 'packaged' : 'development'})\n` +
          `Electron ${info.electron}, Chrome ${info.chrome}, Node ${info.node}, ${info.platform}-${info.arch}`;
        const windows =
          info.windows.length === 0 ? 'No windows.' : untrusted(info.windows.map(renderWindow).join('\n'));
        return `${head}\n${windows}${renderLimitations(result.limitations)}`;
      }
      case 'window': {
        if (input.window === undefined || input.windowAction === undefined) {
          throw new BridgeError('INVALID_PARAMS', 'action=window needs `window` and `windowAction`', {
            hint: 'Get window ids from action=info.',
          });
        }
        const result = await client.call('window.control', {
          window: input.window,
          action: input.windowAction,
          ...definedOf({ bounds: input.bounds }),
        });
        const after = result.data.window;
        const state = after === undefined ? 'closed' : untrusted(renderWindow(after));
        return `Window ${input.window}: ${input.windowAction} done.\n${state}${renderLimitations(result.limitations)}`;
      }
      case 'menu': {
        if ((input.menuId === undefined) === (input.menuPath === undefined)) {
          throw new BridgeError('INVALID_PARAMS', 'action=menu needs exactly one of menuId or menuPath');
        }
        const result = await client.call(
          'menu.click',
          input.menuId === undefined ? { path: input.menuPath ?? [] } : { id: input.menuId },
        );
        return `Clicked menu item ${JSON.stringify(result.data.label)}.${renderLimitations(result.limitations)}`;
      }
    }
  },
});

function renderWindow(window: WindowInfo): string {
  const flags = [
    window.focused ? 'focused' : undefined,
    window.visible ? undefined : 'hidden',
    window.minimized ? 'minimized' : undefined,
  ].filter((flag) => flag !== undefined);
  const { x, y, width, height } = window.bounds;
  const page = window.target === undefined ? '' : ` target=${window.target}`;
  return (
    `window ${window.id}${page} ${JSON.stringify(window.title)} ${width}×${height} at ${x},${y}` +
    (flags.length === 0 ? '' : ` (${flags.join(', ')})`)
  );
}
