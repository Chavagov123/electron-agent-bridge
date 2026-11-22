import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses';

import { electronBinary, type ElectronVersion } from './electron-versions.js';

const exe = process.platform === 'win32' ? '.exe' : '';

/**
 * The Electron executable under another name, next to the original. Electron decides `app.isPackaged`
 * from the executable's name, and its default app still runs the folder given as argument: a cheap
 * stand-in for a production build (no packager needed).
 */
export function packagedElectron(version: ElectronVersion): string {
  const original = electronBinary(version);
  const renamed = join(dirname(original), `EabPackaged${exe}`);
  if (!existsSync(renamed)) {
    try {
      linkSync(original, renamed);
    } catch {
      copyFileSync(original, renamed);
    }
  }
  return renamed;
}

/**
 * A copy of Electron with the fuses that Launch mode relies on turned off (NODE_OPTIONS and
 * `--inspect*` ignored), as hardened production apps ship. On macOS the fuses live in the framework,
 * so the whole app bundle is copied.
 */
export async function fusedElectron(version: ElectronVersion): Promise<string> {
  const original = electronBinary(version);
  const darwin = process.platform === 'darwin';
  const target = darwin ? fusedBundle(original, version) : join(dirname(original), `EabFused${exe}`);
  if (!darwin && !existsSync(target)) copyFileSync(original, target);
  // Outside the bundle: a file inside it would invalidate the signature.
  const marker = darwin ? `${bundleOf(target)}.fused` : `${target}.fused`;
  if (!existsSync(marker)) {
    // codesign refuses bundles with extended attributes ("resource fork … detritus not allowed").
    if (darwin) execFileSync('xattr', ['-cr', bundleOf(target)]);
    await flipFuses(darwin ? bundleOf(target) : target, {
      version: FuseVersion.V1,
      // Re-signed below, with codesign's own error message if it fails.
      resetAdHocDarwinSignature: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
    });
    if (darwin) adHocSign(bundleOf(target));
    writeFileSync(marker, '');
  }
  return target;
}

/** `…/Electron.app/Contents/MacOS/Electron` → a copied bundle's executable in a per-version temp dir. */
function fusedBundle(original: string, version: ElectronVersion): string {
  const bundle = bundleOf(original);
  const copy = join(tmpdir(), `eab-fused-electron-${version}`, basename(bundle));
  if (!existsSync(copy)) {
    mkdirSync(dirname(copy), { recursive: true });
    // ditto keeps a bundle's structure (framework symlinks, metadata) exactly, as codesign needs it.
    execFileSync('ditto', [bundle, copy]);
  }
  return join(copy, 'Contents', 'MacOS', basename(original));
}

function bundleOf(executable: string): string {
  return dirname(dirname(dirname(executable)));
}

/** The harness cannot build a binary a test needs on this platform/version (not a bridge failure). */
export class BinaryUnavailable extends Error {}

/** Re-sign a modified bundle ad hoc (macOS refuses to run it otherwise), reporting codesign's own error. */
function adHocSign(bundle: string): void {
  try {
    execFileSync('codesign', ['--sign', '-', '--force', '--deep', bundle], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const output = error as { stderr?: Buffer; stdout?: Buffer };
    const detail = `${output.stderr?.toString() ?? ''}${output.stdout?.toString() ?? ''}`.trim();
    throw new BinaryUnavailable(`ad-hoc codesign of ${bundle} failed: ${detail}`, { cause: error });
  }
}
