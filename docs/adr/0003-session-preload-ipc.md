# ADR-0003: Renderer IPC capture via session frame preload; subframes are main-side only

- Status: accepted
- Date: 2026-10-27
- Evidence: `spikes/s2-preload` — PASS 8/8 (contextIsolation x sandbox x Electron 35/45)

## Decision
Register our preload with `session.registerPreloadScript({ type: 'frame' })` on every session, and wrap the
`ipcRenderer` methods and `contextBridge.exposeInMainWorld` there.

## Evidence
- Our preload runs **before** the app's `webPreferences.preload` and shares the same `ipcRenderer` and
  `contextBridge` objects (sandbox on and off): 1000 of 1000 app calls captured; the `exposeInMainWorld` wrap works
  with isolation on.
- Per-channel FIFO order is preserved for `send` and `invoke` (500 each, interleaved).
- It runs in `<webview>` guests. It does **not** run in iframes (same-site or cross-site).

## Implementation status
v1 wraps the `ipcRenderer` methods only. The spike verified that `exposeInMainWorld` can be wrapped, but
the shipped preload did not do it; the contextBridge API proxy is part of v1.1.

## Consequences
- Subframe IPC is observed only from main (`senderFrame`) and marked `correlation: 'heuristic'`.
- Request correlation by per-(frame, channel) FIFO is valid for main frames and webviews.
