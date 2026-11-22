import { REDACTED, isSensitiveKey } from '@electron-agent-bridge/core';

/** Longest URL kept; long query strings and data URLs are cut. */
export const MAX_URL_CHARS = 2_000;

/**
 * A URL safe to record: values of secret-looking query parameters (`token`, `api_key`, `password`…)
 * and URL passwords redacted, data URLs reduced to their type, everything clipped.
 */
export function safeUrl(raw: string): string {
  if (raw.startsWith('data:')) {
    const comma = raw.indexOf(',');
    return `${raw.slice(0, Math.min(comma === -1 ? raw.length : comma, 100))},… (${raw.length} chars)`;
  }
  // Nothing to redact without a query or credentials: skip parsing (logs and requests are hot paths).
  if (!raw.includes('?') && !raw.includes('@')) return clip(raw);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return clip(raw);
  }
  let changed = false;
  if (url.password !== '') {
    url.password = REDACTED;
    changed = true;
  }
  for (const key of new Set(url.searchParams.keys())) {
    if (!isSensitiveKey(key)) continue;
    url.searchParams.set(key, REDACTED);
    changed = true;
  }
  return clip(changed ? url.href : raw);
}

function clip(url: string): string {
  return url.length > MAX_URL_CHARS ? `${url.slice(0, MAX_URL_CHARS - 1)}…` : url;
}
