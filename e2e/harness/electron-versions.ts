import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** An Electron major version, e.g. `'45'`. */
export type ElectronVersion = string;

/** Majors installed with the e2e package (`e2e/package.json`); others come from `.electron/<major>`. */
const PACKAGE_BY_VERSION: Readonly<Record<string, string>> = {
  '35': 'electron-35',
  '45': 'electron',
};

const requireFromHere = createRequire(import.meta.url);
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Absolute path of the Electron executable for a major version (the `electron` package exports it).
 * Majors not installed with the e2e package are looked up in `.electron/<major>`, where
 * `node e2e/scripts/install-electron.mjs <majors>` puts them (the nightly matrix does).
 */
export function electronBinary(version: ElectronVersion): string {
  const installed = PACKAGE_BY_VERSION[version];
  let binary: unknown;
  try {
    binary =
      installed === undefined
        ? createRequire(join(repo, '.electron', version, 'package.json'))('electron')
        : requireFromHere(installed);
  } catch (error) {
    throw new Error(
      `Electron ${version} is not installed: run node e2e/scripts/install-electron.mjs ${version}`,
      { cause: error },
    );
  }
  if (typeof binary !== 'string') {
    throw new TypeError(`electron package for ${version} did not export a binary path`);
  }
  return binary;
}

/** Versions selected for this run: `EAB_E2E_ELECTRON=35,45` (default: 45). */
export function selectedVersions(): ElectronVersion[] {
  const raw = process.env['EAB_E2E_ELECTRON'] ?? '45';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^\d+$/.test(value));
}
