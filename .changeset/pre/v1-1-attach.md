---
'@electron-agent-bridge/attach': minor
'@electron-agent-bridge/client': minor
'@electron-agent-bridge/mcp': minor
---

Attach mode: new package `@electron-agent-bridge/attach`. `attach({ port })` drives the renderers of a running app over
its `--remote-debugging-port`, with the engine in the calling process and no runtime inside the app;
main-process methods answer `UNSUPPORTED`. MCP: `session action=attach port=…` (needs
`eab-mcp --allow-eval`). `BridgeClient` now takes any `RpcCaller`.
