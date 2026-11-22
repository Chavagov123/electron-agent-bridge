# ADR-0002: Renderer control through in-process `webContents.debugger`, fire-and-forget bootstrap

- Status: accepted
- Date: 2026-10-27
- Evidence: `spikes/s1-debugger` — PASS 12/12 (6 webPreferences combinations x Electron 35/45, Windows)

## Context
Integrated mode must reach renderers without opening a port and must keep working when fuses are hardened.

## Decision
Attach `wc.debugger` at `web-contents-created` and *post* (never await) in order:
`Runtime.enable`, `Page.enable`, `Runtime.addBinding({ name, executionContextName: '__eab' })`,
`Page.addScriptToEvaluateOnNewDocument({ source: stateHook, runImmediately: true })` (main world) and
`Page.addScriptToEvaluateOnNewDocument({ source: agent, worldName: '__eab', runImmediately: true })`.

## Evidence
- In all 12 runs: agent push through the binding works; the binding is **not** visible in the main world; the
  main-world hook runs before app scripts and captures a store created through the devtools compose hook; the setup
  survives reload; `Runtime.evaluate` in the default context reads state from main.
- Commands sent at `web-contents-created` resolved only after navigation started. Awaiting them would stall bootstrap.

## Consequences
- "Never await debugger commands before the first navigation" is a coding rule.
- Readiness = the first `Runtime.executionContextCreated` for the `__eab` world.
