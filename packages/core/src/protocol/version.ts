/**
 * Version of the client ↔ runtime wire protocol (semver): same major = compatible (pre-1.0: same minor).
 * Bump the minor for additions (new methods, optional fields), the major for breaking changes.
 */
export const PROTOCOL_VERSION = '1.1.0';

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** Parse `x.y.z` (pre-release/build suffixes ignored); `undefined` when malformed. */
export function parseVersion(version: string): ParsedVersion | undefined {
  const match = SEMVER.exec(version);
  if (!match) return undefined;
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  return { major, minor, patch };
}

/**
 * Whether two protocol versions can talk: same major, and for `0.x` also the same minor.
 * Patch differences are always compatible.
 */
export function isProtocolCompatible(a: string, b: string): boolean {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left?.major === undefined || left.major !== right?.major) return false;
  return left.major !== 0 || left.minor === right.minor;
}
