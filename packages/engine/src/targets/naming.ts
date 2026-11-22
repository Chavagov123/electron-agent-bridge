import type { TargetKind } from '@eab/core';

/** File stems that say nothing about the page (every app has an `index.html`). */
const GENERIC_STEMS = new Set(['index', 'main', 'app', 'default', 'home', 'renderer']);
const MAX_NAME = 40;

/** What naming needs to know about a target. */
export interface NameSource {
  readonly kind: TargetKind;
  readonly url: string;
  readonly title: string;
  readonly nameHint?: string;
}

/**
 * The preferred name for a target, or `undefined` while it has nothing to be named after yet
 * (no URL, `about:blank`). Order: the app's explicit name, a distinctive file name, the title,
 * a generic file name, the kind.
 */
export function baseName(target: NameSource): string | undefined {
  const explicit = slug(target.nameHint ?? '');
  if (explicit) return explicit;
  if (target.url === '' || target.url === 'about:blank') return undefined;
  // A `data:` URL's "file name" is its content (an app's HTML dialog): name it by its title instead.
  const stem = target.url.startsWith('data:') ? undefined : slug(urlStem(target.url));
  if (stem && !GENERIC_STEMS.has(stem)) return stem;
  return slug(realTitle(target)) ?? stem ?? target.kind;
}

/** Chromium reports the URL (or for a file, its name) as the title until a page sets one: not a title. */
function realTitle({ url, title }: NameSource): string {
  const file = (url.split(/[?#]/, 1)[0] ?? '').split('/').at(-1) ?? '';
  const placeholder = title === url || title.includes('://') || (file !== '' && title === file);
  return placeholder ? '' : title;
}

/** Make `base` unique against `taken` by appending `-2`, `-3`, … */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Lowercase, `a-z0-9` and single dashes, at most 40 characters; `undefined` if nothing remains. */
export function slug(text: string): string | undefined {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME)
    .replace(/-+$/, '');
  return cleaned === '' ? undefined : cleaned;
}

/** Last path segment without its extension (or the host when there is no path). Pure string work. */
export function urlStem(url: string): string {
  const withoutQuery = url.split(/[?#]/, 1)[0] ?? '';
  const match = /^[a-z][a-z0-9+.-]*:(?:\/\/([^/]*))?(.*)$/i.exec(withoutQuery);
  const host = match?.[1] ?? '';
  const path = match ? (match[2] ?? '') : withoutQuery;
  const last = path
    .split('/')
    .filter((segment) => segment !== '')
    .at(-1);
  return last === undefined ? host : last.replace(/\.[^.]*$/, '');
}
