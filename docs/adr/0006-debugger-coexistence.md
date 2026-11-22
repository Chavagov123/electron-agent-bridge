# ADR-0006: Debugger coexistence — DevTools does not detach us; yield to host `attach`

- Status: accepted
- Date: 2026-10-27
- Evidence: `spikes/s6-detach` (Electron 35/45)

## Evidence
- Opening and closing DevTools does **not** detach our `wc.debugger`; commands keep working throughout.
- A host `wc.debugger.attach()` while we are attached **throws** "Debugger is already attached to the target".
- With a guard (wrap `attach` and detach ours first) the host attach succeeds and works.

## Decision
`DebuggerGuard` wraps `wc.debugger.attach`. When the host attaches, we detach, mark the target
`attached: false, reason: 'host-debugger'` and stop. No DevTools re-attach logic is required, but detach handling
stays for robustness.
