# ADR-0009: Crash observation — `uncaughtExceptionMonitor` + `'warning'`, never `unhandledRejection`

- Status: accepted
- Date: 2026-10-27
- Evidence: `spikes/s12-crash` — 16/16 (throw/reject x app handler on/off x bridge on/off x Electron 35/45)

## Evidence
- Throws: with no app handler Electron shows its error dialog; with an app handler the app handles it. Adding
  `uncaughtExceptionMonitor` observes every throw and changes neither behaviour.
- Rejections: Electron main does **not** crash on unhandled rejections (warn mode), and the monitor does not see
  them. `process.on('warning')` receives `UnhandledPromiseRejectionWarning`, and the stderr warning is still printed.

## Decision
Observe throws with `uncaughtExceptionMonitor` and rejections with `process.on('warning')` filtered to
`UnhandledPromiseRejectionWarning`. Never register `uncaughtException` or `unhandledRejection` listeners.
