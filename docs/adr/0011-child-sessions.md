# ADR-0011: Workers, service workers and cross-site iframes through flattened auto-attach

- Status: accepted
- Date: 2026-11-18
- Evidence: spike S12 (Electron 35.7.5 and 45.0.0, Windows): a page over local HTTP with a cross-site
  iframe, a dedicated worker and a service worker

## Context
PLAN 5.4 assumed service workers were not reachable through page-level auto-attach on the
in-process debugger, and v1 ignored every child session.

## Evidence
With `Target.setAutoAttach { autoAttach, flatten, waitForDebuggerOnStart: false }` on the page's
`webContents.debugger`, both versions report `attachedToTarget` for the iframe, the dedicated worker
and the service worker, and deliver their `Runtime.consoleAPICalled` with the child's session id.

## Decision
Post `Target.setAutoAttach` fire-and-forget on every page and after every re-attach (ADR-0002); never
pause children. Each child session becomes a transport of its own (commands carry its session id,
only its events are delivered, without the id), so the console and network collectors follow children
unchanged. Workers and service workers are listed as targets (`worker`, `serviceWorker`) with ids like
`wc3:w1`; page tools refuse them. A service worker shared by several pages is followed once; at most
50 children are followed.

## Consequences
- Logs and requests of workers, service workers and cross-site iframes are recorded.
- Cross-site iframes are not part of their page's snapshot yet (their content needs the agent in the
  child session and stitched refs); this remains open.
