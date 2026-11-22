# ADR-0005: IPC sources — wrapping primary, documented events secondary, undocumented events experimental

- Status: accepted
- Date: 2026-10-27
- Evidence: `spikes/s4-session-ipc` (Electron 35/45)

## Evidence
- Documented `webContents` events `'ipc-message'` and `'ipc-message-sync'` fire on both versions, including for
  channels nobody handles.
- There is no documented event for `invoke`.
- The undocumented `-ipc-message` / `-ipc-invoke` / `-ipc-message-sync` events are emitted on **webContents** in 35
  but on **session** in 45, and both include Electron-internal channels (`BROWSER_*`).

## Decision
- Primary: wrap `ipcMain`, `wc.ipc` and frame `ipc` registration, plus outbound sends.
- Secondary: documented webContents events, to catch `send`/`sendSync` on channels registered before us.
- Experimental (opt-in, feature-detected): listen on both session and webContents for `-ipc-*` and filter internal
  channel names.
