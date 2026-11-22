# IPC capture

The bridge records the app's IPC so agents can see what the UI asked the main process to do, and what
an action caused (`act` observations, `wait_for` with `kind: "ipc"`, the `ipc` tool / `ipc.query`).

## What is recorded

| Source | Kinds | Correlation |
|---|---|---|
| `ipcMain.handle` / `handleOnce` | `invoke` request, `handle` response or error, with duration | exact (one id per call) |
| `ipcMain.on` / `once` / `addListener` | `send` or `sendSync` request (one record per message, however many listeners); for `sendSync`, the value a listener sets on `event.returnValue` as the response (1.1) | exact |
| `webContents.ipc` and frame `ipc` handlers and listeners | as above, scoped to that page or frame | exact |
| `webContents.send` / `postMessage` / `sendToFrame` | `toRenderer` | — |
| Renderer (session frame preload, main frames and webviews) | `ipcRenderer.send` / `sendSync` (with response) / `invoke` (with response or error) / `postMessage` | paired first-in, first-out with the main-side record; `heuristic` when there is none |
| Documented `ipc-message(-sync)` events | messages to channels with no wrapped listener | heuristic |
| `utilityProcess.fork` children (1.1) | `utilityMessage` on `utility:<serviceName>`: `direction: out` (main posted) or `in` (the child posted), sender `u<pid>` | — |
| `MessagePortMain` in main (1.1) | `portMessage` on `port:p<n>` (one id per port): `out` or `in` | — |
| `contextBridge.exposeInMainWorld` / `exposeInIsolatedWorld` (1.1) | `bridgeCall` on `bridge:<key>.<path>` when the page calls an exposed function: request, then response or error, with duration | exact |

Arguments and results are recorded as **shapes** (`number[2]`, `{id: number}[1]`). Values are recorded
only for channels the app opts in, and then with secret-looking keys redacted:

```js
require('@eab/electron').enableAgentBridge({ ipc: { values: ['settings:*'] } });
```

### Inferred types (1.1)

`ipc.query { schemas: true }` (MCP: `ipc schemas=true`) lists each channel with the types inferred from
its main-side messages, e.g. `orders:save (handle/invoke ×12): (a: {id: number, note?: string}) → boolean`.
Keys missing from some messages are optional, differing types become unions; only the first 50 messages
per channel and phase are merged. Renderer-only records carry shapes, not values, so channels seen only
in renderers have no inferred types.

Records live in a 2 MB ring; readers are told how many were evicted (`dropped`). Channels registered
before the bridge installed (Electron's own, or code loaded earlier) and Electron-internal channels are
tagged `internal` and hidden unless `includeInternal` is set.

## Limits

- Iframes do not run the session preload: their IPC is seen from main only.
- Without context isolation the page shares the preload's world and could forge records: they are
  marked `trust: "low"`.
- Listeners registered before the bridge are not wrapped; their messages show up through the
  documented events only when no wrapped listener exists for the channel.
- `ipcMain.listeners(channel)` returns the bridge's wrappers, not the app's functions (everything else
  behaves the same; removal works with the app's functions).
- Utility processes: their stdout and stderr are not read (attaching a reader would switch the streams
  to flowing mode and change what the app sees); exits are logged from `child-process-gone`.
- MessagePorts: only `MessagePortMain` in main is seen; ports in renderers are the web's `MessagePort`.
  The port prototype is patched once (delegating), because `MessageChannelMain` itself cannot be
  replaced.
- contextBridge: plain objects of the exposed API are copied with their functions wrapped (contextBridge
  copies them anyway); class instances and other values pass through untouched.
