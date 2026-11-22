# @eab/mcp

## 1.1.0-rc.0

### Minor Changes

- First public release of electron-agent-bridge: Integrated and Launch modes; targets, snapshots and
  deltas, actions and waits, IPC capture, logs and network, application state, main-process control,
  MCP server and `eab` CLI, YAML flows with `eab run`.
- Component state and faster actions. `state.component` (MCP `state action=component ref=…`) reads the
  React or Vue 3 component behind an element: props, state hooks or setup state, and the components around
  it. Actions take fewer round trips: settling and sampling the page are one call, all but the last input
  event of a gesture are posted, and locator lookups are reused while the DOM is unchanged.
- Attach mode: new package `@eab/attach`. `attach({ port })` drives the renderers of a running app over
  its `--remote-debugging-port`, with the engine in the calling process and no runtime inside the app;
  main-process methods answer `UNSUPPORTED`. MCP: `session action=attach port=…` (needs
  `eab-mcp --allow-eval`). `BridgeClient` now takes any `RpcCaller`.
- Flow recorder and Playwright export. `record.start` / `record.events` / `record.stop` capture what
  users do in the app's pages (clicks, field values, checkbox/select changes, command keys) and what
  agents run with `act`, each with a locator that outlives refs; password values are never recorded.
  `eab record --out flow.yaml` and the MCP `session` actions `recordStart`/`recordStop` turn that into a
  flow. `eab export <flow> --playwright` (or `toPlaywright(flow)`) writes the flow as a Playwright test
  for Electron. `stringifyFlow` and `flowFromRecording` are new in `@eab/client`.
- Launch mode reads the fuses written in the Electron binary before starting it and skips strategies
  they block, failing at once with the exact fuses when none can work. `eab doctor <executable>` reports
  the fuses, asar packaging and which launch strategies can work. New `readFuses` and
  `blockedStrategies` in `@eab/client`.
- Protocol 1.1.0 groundwork. Action step results report the elements they acted on (`resolved`).
  `session.auth` reports the connection `mode` and the `features` it serves, and MCP hides tools a
  connection cannot serve. `launch({ options })` passes runtime options (IPC value channels, main console,
  click listeners) to a launched app through `EAB_OPTIONS`, so they work in Launch mode too. New limitation
  code `degraded`.
- Main-process observability. IPC capture also records `utilityProcess` messages (`utility:<name>`),
  `MessagePortMain` messages (`port:p<n>`) and calls into preload APIs exposed through `contextBridge`
  (`bridge:<key>.<fn>`). `ipc.query { schemas: true }` (MCP `ipc schemas=true`) infers each channel's
  argument and result types. `network.query` records the main process's own requests (Node `http`/`https`,
  global `fetch`, Electron `net`) as target `main`, and marks responses served by a service worker. Log
  stacks are mapped to original sources through source maps when read (`logs.sourceMaps`, default on).

### Patch Changes

- Updated dependencies
- Updated dependencies [c4fa0ec]
- Updated dependencies [0d1055e]
- Updated dependencies [22096cf]
- Updated dependencies [c4fa0ec]
- Updated dependencies [c4fa0ec]
- Updated dependencies [1dda16c]
- Updated dependencies [2ee5a5c]
- Updated dependencies [f77c7a9]
- Updated dependencies [b85cb50]
  - @eab/core@1.1.0-rc.0
  - @eab/client@1.1.0-rc.0
  - @eab/attach@1.1.0-rc.0
