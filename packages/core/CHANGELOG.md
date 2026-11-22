# @electron-agent-bridge/core


## 1.1.0

First stable release: everything in 1.1.0-rc.0 (below).

## 1.1.0-rc.0

### Minor Changes

- First public release of electron-agent-bridge: Integrated and Launch modes; targets, snapshots and
  deltas, actions and waits, IPC capture, logs and network, application state, main-process control,
  MCP server and `eab` CLI, YAML flows with `eab run`.
- Component state and faster actions. `state.component` (MCP `state action=component ref=…`) reads the
  React or Vue 3 component behind an element: props, state hooks or setup state, and the components around
  it. Actions take fewer round trips: settling and sampling the page are one call, all but the last input
  event of a gesture are posted, and locator lookups are reused while the DOM is unchanged.
- Workers, service workers and cross-site iframes: the runtime auto-attaches to their sessions and records
  their console output and requests (ids like `wc3:w1`). Workers and service workers are listed by
  `targets` as kinds `worker` and `serviceWorker`; page tools refuse them with `UNSUPPORTED`.
- Flow recorder and Playwright export. `record.start` / `record.events` / `record.stop` capture what
  users do in the app's pages (clicks, field values, checkbox/select changes, command keys) and what
  agents run with `act`, each with a locator that outlives refs; password values are never recorded.
  `eab record --out flow.yaml` and the MCP `session` actions `recordStart`/`recordStop` turn that into a
  flow. `eab export <flow> --playwright` (or `toPlaywright(flow)`) writes the flow as a Playwright test
  for Electron. `stringifyFlow` and `flowFromRecording` are new in `@electron-agent-bridge/client`.
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
- Offscreen windows (`webPreferences.offscreen`) are targets of kind `offscreen`: snapshots, actions and
  screenshots work on them; they are never the default target.
- Fixes found driving a large bundled React app:
  
  - Snapshots no longer fold a page's own content at the top level, where there is no ref to expand it:
    only a list of like items (mostly one role) folds there.
  - Log entries point at the app code that wrote them: frames of console wrappers (a DevTools extension's
    hook, an error reporter's console patch, dependencies) are passed over, ten frames are kept, and
    entries carry a `column` (protocol 1.1) so locations without a stack are source-mapped too.
  - Source maps of large bundles are found: only the end of a script is read for its
    `sourceMappingURL`, maps up to 32 MB are read, and the cache is bounded by size as well as count.
  - Exported Playwright tests find windows by the bridge's target names (slugs of file name or title).
  - Attach mode reports the app's name, version and main process id, and says why no store is found
    when the page loaded before attaching.
