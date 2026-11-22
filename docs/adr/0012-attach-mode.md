# ADR-0012: Attach mode in its own package, the engine in the client process

- Status: accepted
- Date: 2026-11-18

## Context
v1 needs the runtime inside the app. Some apps cannot take it (fuses block Launch mode, no access to
the code) but can be started with `--remote-debugging-port`, which no fuse controls.

## Decision
A new package, `@eab/attach`, runs the engine in the calling process over one DevTools WebSocket per
page (`WebSocketCdpTransport`), with pages read from `/json/list` (`RemoteTargetSource`). It returns an
ordinary `BridgeClient`: the client now takes any `RpcCaller`, and an in-process dispatcher validates
params against the protocol table like the runtime does. Main-process methods answer `UNSUPPORTED`;
`session.auth`-style info reports `mode: attach` and the features served, so the MCP server hides the
main-process tools. The engine stays free of Node and sockets; the client stays free of the engine; a
dependency rule keeps the attach package away from the in-app runtime and from mcp.

## Consequences
- Renderer features work without anything in the app; IPC, main logs and main control do not.
- Whoever reaches the debugging port controls the pages: MCP only attaches on a server started with
  `--allow-eval`.
- Without the runtime, windows and views are not told apart and focus is unknown.
