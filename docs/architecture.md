# Architecture

## Packages and dependencies

```
@electron-agent-bridge/mcp ──► @electron-agent-bridge/client ──► @electron-agent-bridge/core ◄── @electron-agent-bridge/engine ◄── @electron-agent-bridge/electron
   (MCP server, eab CLI)  (Node API, flows)   (protocol)    (CDP engine)    (in-app runtime)
                                                                │
                                                     @electron-agent-bridge/page-agent (in-page scripts, built to strings)
```

- **core**: the protocol table (every method's params, result and capability, as zod schemas), error
  codes, envelopes with `limitations[]`, byte rings, redaction and shapes. Isomorphic; zod only.
- **page-agent**: the isolated-world agent (accessibility tree, refs, snapshots and deltas, find,
  actionability) and the main-world state hook. No dependencies; bundled to strings by `pnpm gen`.
- **engine**: transport-agnostic automation over a `CdpTransport` port: targets and names, snapshots,
  actions and waits, observations, console and network collectors, state reads. No Electron, no Node.
- **electron**: the runtime inside the app's main process: gate, control socket and auth, the in-process
  debugger transport, IPC wrappers and the renderer preload, main-process logs, main control. Bundles
  core, engine and page-agent, so the app gets no transitive runtime dependencies.
- **client**: `connect` (discovery, auth, typed calls), `launch` (Launch mode), flows.
- **attach** (1.1): Attach mode — the engine in the client process over the app's remote debugging
  port (one DevTools WebSocket per page); returns an ordinary `BridgeClient`.
- **mcp**: the MCP server and the `eab` CLI, both on top of the client's API (and attach's).

The boundaries are enforced in CI (dependency-cruiser): e.g. the engine cannot import Electron or Node,
the runtime cannot import client code, MCP talks to apps only through the client.

## Data flow

1. **Install.** `import '@electron-agent-bridge/electron/register'` (Integrated) or the inject (Launch mode, via
   `NODE_OPTIONS --require` or the inspector) runs first in the main process. The gate decides:
   `EAB_ENABLE=1` and (unpackaged or opted in). Off means nothing is hooked, opened or written.
2. **Hooks.** Synchronously, before the app's own code: IPC wrappers (`ipcMain`, `webContents.ipc`,
   frame `ipc`, outbound sends), the session preload, main-process log capture, and target tracking:
   every page's `webContents.debugger` is attached at creation and set up fire-and-forget (ADR-0002).
3. **Control channel.** A Unix socket or named pipe in a private per-user directory, a handshake file
   with a random token, NDJSON JSON-RPC 2.0, protocol-version check at auth (ADR-0001).
4. **Calls.** Each call is checked against the session's capabilities, validated against the protocol
   table, audited (metadata only), and answered by the engine or the runtime.
5. **Pages.** The page agent lives in an isolated world (`__eab`) and keeps a cached accessibility tree
   updated by a MutationObserver; snapshots and deltas are computed in the page. Input is trusted CDP
   input. State is read from the main-world registry on demand. A page waiting on an unanswered
   `ipcRenderer.sendSync` runs nothing; the runtime tracks those waits from its IPC wrappers, and page
   calls to a blocked page (a window opened meanwhile, or 5 s passed, and a probe evaluation fails)
   fail fast with `TIMEOUT`, naming the channel (a dialog is usually open).
6. **Off the main thread.** Source maps for `logs.query` are read, parsed and resolved in a worker
   thread (stopped after 5 minutes idle; the main process takes over if it keeps failing), so a large
   bundle's maps never stall the app. A query waits up to 2 s for them, then answers with stacks as
   recorded and a `partial` limitation.

## Decisions

The ADRs in [adr/](adr) record why: control channel (0001), in-process debugger and fire-and-forget
bootstrap (0002), session preload for renderer IPC (0003), install ordering (0004), IPC sources (0005),
debugger coexistence with the host app (0006), snapshot performance design (0007), trusted input
(0008), crash observation without changing behaviour (0009), floods and the console rate cap
(0010), workers and iframes through auto-attach (0011), Attach mode (0012).
