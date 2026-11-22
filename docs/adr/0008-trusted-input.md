# ADR-0008: Input — trusted CDP mouse events on the top-level session reach OOPIFs and webviews

- Status: accepted
- Date: 2026-10-27
- Evidence: `spikes/s8-input` — PASS 5/5 paths x Electron 35/45

## Evidence
`Input.dispatchMouseEvent` produced `isTrusted: true` clicks for: a top-level button; a cross-site OOPIF via
top-level coordinates; the OOPIF via its own flattened session; a `<webview>` via top-level coordinates; the
`<webview>` via its guest `webContents.debugger`.

## Decision
The InputDriver dispatches on the top-level session using page coordinates (frame offsets accumulated); Chromium's
hit-testing routes the events into OOPIFs and webviews. Per-frame sessions remain available. The JS-event fallback is
used only when CDP input fails.
