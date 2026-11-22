import { BridgeError, ok, type Envelope, type MethodData, type MethodInput } from '@eab/core';

import type { WindowsLike } from './windows.js';

/** The parts of `MenuItem` / `Menu` the bridge uses (faked in tests). */
export interface MenuItemLike {
  readonly label: string;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly type: string;
  readonly submenu?: MenuLike | null;
  click(event?: unknown, focusedWindow?: unknown, focusedWebContents?: unknown): void;
}

export interface MenuLike {
  readonly items: MenuItemLike[];
  getMenuItemById(id: string): MenuItemLike | null;
}

/** Labels compare without mnemonics (`&File`), trailing ellipses, case or surrounding space. */
function normalise(label: string): string {
  return label
    .replace(/&(?!&)/g, '')
    .replace(/(?:\.\.\.|…)$/, '')
    .trim()
    .toLowerCase();
}

/** `menu.click`: click an application-menu item by id or label path, as a user would. */
export function clickMenu(
  menu: MenuLike | null,
  windows: WindowsLike,
  input: MethodInput<'menu.click'>,
): Envelope<MethodData<'menu.click'>> {
  if (!menu) throw new BridgeError('NOT_FOUND', 'the app has no application menu');
  const chain = input.id === undefined ? byPath(menu, input.path ?? []) : byId(menu, input.id);
  const item = chain.at(-1);
  if (!item) throw new BridgeError('INVALID_PARAMS', 'empty menu path');
  // Every menu on the way must be usable too, as for a user.
  for (const parent of chain.slice(0, -1)) {
    if (!parent.visible) throw new BridgeError('HIDDEN', `menu "${parent.label}" is hidden`);
    if (!parent.enabled) throw new BridgeError('DISABLED', `menu "${parent.label}" is disabled`);
  }
  if (item.type === 'submenu' || item.type === 'separator') {
    throw new BridgeError('INVALID_PARAMS', `"${item.label}" is a ${item.type}, not a clickable item`, {
      hint: 'Give the full path to an item inside it.',
    });
  }
  if (!item.visible) throw new BridgeError('HIDDEN', `menu item "${item.label}" is hidden`);
  if (!item.enabled) throw new BridgeError('DISABLED', `menu item "${item.label}" is disabled`);
  const focused = windows.getFocusedWindow() ?? windows.getAllWindows()[0];
  item.click({ triggeredByAccelerator: false }, focused, focused?.webContents);
  return ok({ label: item.label });
}

/** The item with this id and the menus leading to it. */
function byId(menu: MenuLike, id: string): MenuItemLike[] {
  const target = menu.getMenuItemById(id);
  const chain = target ? chainTo(menu.items, target) : undefined;
  if (!chain) throw new BridgeError('NOT_FOUND', `no menu item with id "${id}"`);
  return chain;
}

function chainTo(items: readonly MenuItemLike[], target: MenuItemLike): MenuItemLike[] | undefined {
  for (const item of items) {
    if (item === target) return [item];
    const below = item.submenu ? chainTo(item.submenu.items, target) : undefined;
    if (below) return [item, ...below];
  }
  return undefined;
}

/** Items along a label path. Of items sharing a label (e.g. per-platform variants), a usable one wins. */
function byPath(menu: MenuLike, path: readonly string[]): MenuItemLike[] {
  let items = menu.items;
  const chain: MenuItemLike[] = [];
  for (const [depth, label] of path.entries()) {
    const matches = items.filter((item) => normalise(item.label) === normalise(label));
    const found =
      matches.find((item) => item.visible && item.enabled) ??
      matches.find((item) => item.visible) ??
      matches[0];
    if (!found) {
      const here = items
        .filter((item) => item.type !== 'separator' && item.visible)
        .map((item) => item.label);
      throw new BridgeError(
        'NOT_FOUND',
        `no menu item "${label}" in ${path.slice(0, depth).join(' › ') || 'the menu bar'}`,
        { hint: `Items here: ${here.map((text) => JSON.stringify(text)).join(', ')}` },
      );
    }
    chain.push(found);
    items = found.submenu?.items ?? [];
  }
  return chain;
}
