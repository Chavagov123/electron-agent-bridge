import { BridgeError } from '../errors/bridge-error.js';

/** Default cap for one framed message (characters). Larger payloads are spilled to files, never framed. */
export const MAX_LINE_CHARS = 8 * 1024 * 1024;

/** Frame one message as a newline-delimited JSON line. `JSON.stringify` escapes newlines inside strings. */
export function encodeLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Incremental NDJSON line splitter. Feed it decoded text chunks; it returns complete lines.
 * Throws `BUDGET_EXCEEDED` when a single line grows past the cap, so a peer cannot exhaust memory.
 */
export class LineDecoder {
  readonly #maxLineChars: number;
  /** Pieces of the unfinished line; joined once, when its newline arrives (linear in input size). */
  #pending: string[] = [];
  #pendingLength = 0;

  constructor(maxLineChars: number = MAX_LINE_CHARS) {
    this.#maxLineChars = maxLineChars;
  }

  push(chunk: string): string[] {
    const pieces = chunk.split('\n');
    const tail = pieces.pop() ?? '';
    const lines: string[] = [];
    for (const [index, piece] of pieces.entries()) {
      const line = index === 0 ? this.#takePending(piece) : piece;
      this.#check(line.length);
      if (line.trim() !== '') lines.push(line);
    }
    this.#pending.push(tail);
    this.#pendingLength += tail.length;
    this.#check(this.#pendingLength);
    return lines;
  }

  #takePending(piece: string): string {
    const line = this.#pending.join('') + piece;
    this.#pending = [];
    this.#pendingLength = 0;
    return line;
  }

  #check(length: number): void {
    if (length <= this.#maxLineChars) return;
    this.#pending = [];
    this.#pendingLength = 0;
    throw new BridgeError('BUDGET_EXCEEDED', `message exceeds ${this.#maxLineChars} characters`);
  }
}
