/** UTF-8 byte length of a string without Buffer/TextEncoder (core is isomorphic and dependency-free). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(index + 1))) {
      // A surrogate pair is one 4-byte code point.
      bytes += 4;
      index++;
    } else bytes += 3; // BMP character, or a lone surrogate (encoded as U+FFFD, 3 bytes)
  }
  return bytes;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Approximate wire size of a JSON-serialisable value: UTF-8 bytes of its JSON text.
 * Values that cannot be serialised (cycles, BigInt) count as `fallback` bytes instead of throwing.
 */
export function jsonByteSize(value: unknown, fallback = 1024): number {
  try {
    const text = JSON.stringify(value) as string | undefined;
    return text === undefined ? 0 : utf8Length(text);
  } catch {
    return fallback;
  }
}
