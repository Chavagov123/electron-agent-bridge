import { selectedVersions, type ElectronVersion } from './electron-versions.js';

/** How the bridge gets into a fixture: imported by the app, or injected by the launcher. */
export type BridgeMode = 'integrated' | 'launch';

/** Modes selected for this run: `EAB_E2E_MODES=integrated,launch` (default: both). */
export function selectedModes(): BridgeMode[] {
  const raw = process.env['EAB_E2E_MODES'] ?? 'integrated,launch';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is BridgeMode => value === 'integrated' || value === 'launch');
}

/** Every selected Electron version in every selected mode, for `describe.each`. */
export function versionModes(): [ElectronVersion, BridgeMode][] {
  return selectedVersions().flatMap((version) =>
    selectedModes().map((mode): [ElectronVersion, BridgeMode] => [version, mode]),
  );
}
