---
'@eab/core': minor
'@eab/engine': minor
'@eab/electron': minor
'@eab/mcp': minor
---

Main-process observability. IPC capture also records `utilityProcess` messages (`utility:<name>`),
`MessagePortMain` messages (`port:p<n>`) and calls into preload APIs exposed through `contextBridge`
(`bridge:<key>.<fn>`). `ipc.query { schemas: true }` (MCP `ipc schemas=true`) infers each channel's
argument and result types. `network.query` records the main process's own requests (Node `http`/`https`,
global `fetch`, Electron `net`) as target `main`, and marks responses served by a service worker. Log
stacks are mapped to original sources through source maps when read (`logs.sourceMaps`, default on).
