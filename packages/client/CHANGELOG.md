# @eab/client

## 1.1.0-rc.0

### Minor Changes

- First public release of electron-agent-bridge: Integrated and Launch modes; targets, snapshots and
  deltas, actions and waits, IPC capture, logs and network, application state, main-process control,
  MCP server and `eab` CLI, YAML flows with `eab run`.
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

### Patch Changes

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
- Updated dependencies
- Updated dependencies [c4fa0ec]
- Updated dependencies [22096cf]
- Updated dependencies [26ba027]
- Updated dependencies [c4fa0ec]
- Updated dependencies [1dda16c]
- Updated dependencies [2ee5a5c]
- Updated dependencies [f77c7a9]
- Updated dependencies [1c24fab]
- Updated dependencies [b85cb50]
  - @eab/core@1.1.0-rc.0
  - @eab/electron@1.1.0-rc.0
