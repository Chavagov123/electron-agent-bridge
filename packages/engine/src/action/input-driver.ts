import type { CdpTransport } from '../ports/cdp-transport.js';
import { MODIFIERS, SHIFT_BIT, parseChord, type KeyDefinition } from './keys.js';

export type MouseButton = 'left' | 'right' | 'middle';

export interface ClickOptions {
  readonly button?: MouseButton;
  readonly clickCount?: number;
  readonly modifiers?: readonly string[];
}

/** Points are in CSS pixels of the top-level viewport. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Trusted input through CDP (`Input.*`, ADR-0008): events the page sees as real user input
 * (`isTrusted`), dispatched through the top-level session so they also reach frames and webviews.
 */
export class InputDriver {
  readonly #transport: CdpTransport;

  constructor(transport: CdpTransport) {
    this.#transport = transport;
  }

  async move(point: Point, modifiers = 0): Promise<void> {
    await this.#mouse({ type: 'mouseMoved', ...at(point), modifiers });
  }

  /**
   * Move, then press and release (`clickCount` times). Every event but the last is posted: CDP handles
   * one session's commands in order, so only the last needs a round trip (it fails if the page went away).
   */
  async click(point: Point, options: ClickOptions = {}): Promise<void> {
    const button = options.button ?? 'left';
    const modifiers = maskOf(options.modifiers ?? []);
    const clicks = options.clickCount ?? 1;
    this.#post({ type: 'mouseMoved', ...at(point), modifiers });
    for (let count = 1; count <= clicks; count++) {
      this.#post({ type: 'mousePressed', ...at(point), button, clickCount: count, modifiers });
      const release = { type: 'mouseReleased', ...at(point), button, clickCount: count, modifiers };
      if (count < clicks) this.#post(release);
      else await this.#mouse(release);
    }
  }

  async wheel(point: Point, deltaX: number, deltaY: number): Promise<void> {
    await this.#mouse({ type: 'mouseWheel', ...at(point), deltaX, deltaY });
  }

  /** Press, move in small steps, release: pointer-based drag (sliders, sortable lists, canvases). */
  async drag(from: Point, to: Point, steps = 8): Promise<void> {
    await this.move(from);
    await this.#mouse({ type: 'mousePressed', ...at(from), button: 'left', clickCount: 1 });
    for (let step = 1; step <= steps; step++) {
      const x = from.x + ((to.x - from.x) * step) / steps;
      const y = from.y + ((to.y - from.y) * step) / steps;
      await this.#mouse({ type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    }
    await this.#mouse({ type: 'mouseReleased', ...at(to), button: 'left', clickCount: 1 });
  }

  /** Insert text at the focus as IME-style input (one input event, works with any keyboard layout). */
  async insertText(text: string): Promise<void> {
    await this.#transport.send('Input.insertText', { text });
  }

  /** Press a key or chord (`Enter`, `Control+S`): modifiers down, key down/up, modifiers up. */
  async press(chord: string): Promise<void> {
    const parsed = parseChord(chord);
    let mask = 0;
    for (const modifier of parsed.modifiers) {
      mask |= modifier.bit;
      await this.#key('rawKeyDown', modifier.definition, mask, false);
    }
    // Shortcuts (Control/Alt/Meta held) insert no text.
    const withText = (parsed.mask & ~SHIFT_BIT) === 0;
    await this.#key('keyDown', parsed.key, mask, withText);
    await this.#key('keyUp', parsed.key, mask, false);
    for (const modifier of [...parsed.modifiers].reverse()) {
      mask &= ~modifier.bit;
      await this.#key('keyUp', modifier.definition, mask, false);
    }
  }

  async #key(
    type: 'keyDown' | 'rawKeyDown' | 'keyUp',
    key: KeyDefinition,
    modifiers: number,
    withText: boolean,
  ): Promise<void> {
    const text = withText ? key.text : undefined;
    await this.#transport.send('Input.dispatchKeyEvent', {
      type: type === 'keyDown' && text === undefined ? 'rawKeyDown' : type,
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      nativeVirtualKeyCode: key.keyCode,
      modifiers,
      ...(text === undefined ? {} : { text, unmodifiedText: text }),
    });
  }

  async #mouse(params: Record<string, unknown>): Promise<void> {
    await this.#transport.send('Input.dispatchMouseEvent', params);
  }

  #post(params: Record<string, unknown>): void {
    this.#transport.post('Input.dispatchMouseEvent', params);
  }
}

function maskOf(modifiers: readonly string[]): number {
  return modifiers.reduce((bits, name) => bits | (MODIFIERS[name]?.bit ?? 0), 0);
}

/** Only the coordinates: callers often pass richer objects (action targets) as points. */
function at(point: Point): { x: number; y: number } {
  return { x: point.x, y: point.y };
}
