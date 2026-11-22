---
'@electron-agent-bridge/core': minor
'@electron-agent-bridge/engine': minor
'@electron-agent-bridge/electron': minor
'@electron-agent-bridge/client': minor
'@electron-agent-bridge/mcp': minor
---

Protocol 1.1.0 groundwork. Action step results report the elements they acted on (`resolved`).
`session.auth` reports the connection `mode` and the `features` it serves, and MCP hides tools a
connection cannot serve. `launch({ options })` passes runtime options (IPC value channels, main console,
click listeners) to a launched app through `EAB_OPTIONS`, so they work in Launch mode too. New limitation
code `degraded`.
