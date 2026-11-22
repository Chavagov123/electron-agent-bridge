# ADR-0004: Install ordering — `register` first import; Launch via NODE_OPTIONS deferred hook, inspector fallback

- Status: accepted
- Date: 2026-10-27
- Evidence: `spikes/s3-ordering` — PASS 16/16 (Windows, Electron 35/45, CJS and ESM mains)

## Decision
1. Integrated: side-effect `import '@electron-agent-bridge/electron/register'` as the first import (CJS and ESM verified).
2. Launch (a): `NODE_OPTIONS=--require <inject>`. The inject installs **deferred**: try immediately, then wrap
   `Module._load` and retry on each load, then `process.nextTick`; unhook once installed.
3. Launch (b): `--inspect-brk=0` plus `Debugger.setInstrumentationBreakpoint('beforeScriptExecution')`. Resume until
   the first user script (or `default_app.asar/main.js` in development; the URL is in `params.data.url`), inject
   there, remove the breakpoint, resume, close the inspector.

## Findings
- `require('electron')` is **not** resolvable at `--require` time; Electron registers it later in browser init.
- Windows: `NODE_OPTIONS` paths must use forward slashes (backslashes are stripped).
- A plain `--inspect-brk` pause is too early (`process` undefined, internal debuglog errors).
- Electron 35 does not pause on CJS user scripts with the instrumentation breakpoint; the `default_app` pause covers
  development runs.
- On 45 the deferred hook lands before Electron's own `IMPORT_SHARED_TEXTURE_*` `ipcMain` registration.

## Consequences
- The IPC recorder tags registrations made before the app's main script as `internal`.
- The launch `NODE_OPTIONS` entry is scrubbed from `process.env` after install so children do not inherit it.
- Packaged apps (no `default_app`) on Electron 35 with a CJS main: inspector path unverified, so diagnose and
  recommend Integrated mode.
