# @eab/electron

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
- Lighter under floods: log entries are sized without serializing them, URLs with nothing to redact are
  not parsed, and plain console calls skip the schema walk. Each page's console is recorded at up to
  1,000 messages per second (bursts of 2,000); what goes over is counted and reported. Every fixture
  can measure the main event-loop delay; the perf spec now covers IPC and console floods.
- Flow recorder and Playwright export. `record.start` / `record.events` / `record.stop` capture what
  users do in the app's pages (clicks, field values, checkbox/select changes, command keys) and what
  agents run with `act`, each with a locator that outlives refs; password values are never recorded.
  `eab record --out flow.yaml` and the MCP `session` actions `recordStart`/`recordStop` turn that into a
  flow. `eab export <flow> --playwright` (or `toPlaywright(flow)`) writes the flow as a Playwright test
  for Electron. `stringifyFlow` and `flowFromRecording` are new in `@eab/client`.
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

### Patch Changes

- Fixes found driving a large bundled app:
  
  - Source maps are read, parsed and resolved in a worker thread, so the app's main process never stops
    for them (before, the first `logs.query` on a large bundle blocked it for seconds). A query waits up
    to 2 s; if maps are still loading it returns entries as recorded with a `partial` limitation. The
    `StackMapper` port is now batched and asynchronous (`mapAll`); `LocationMapper` is the synchronous
    form.
  - Frames in a message's text are mapped too. React's component stack in its warnings is one example.
    When a warning's own stack is all dependencies, the first app component in the text gives its
    location.
  - `sendSync`: the main-side record now carries the value a listener sets on `event.returnValue` as the
    response, so inferred IPC types include the reply. This works on every supported Electron, and the
    reply still reaches the renderer unchanged.
  - `main.eval` errors show the caller's stack, from the error line to the expression's frame, without the
    bridge's wrapper or file paths.
  - The limitation for messages stored before capture started says they carry only their top frame.
  - A page loaded from a `data:` URL (an app's HTML dialog window) is named after its title, not its
    content.
  - A page blocked on an unanswered `ipcRenderer.sendSync` (an app's dialog window is open) no longer
    hangs page calls until the client gives up: they fail with `TIMEOUT`, naming the channel, saying
    whether the call ran, and listing the other targets to answer first. It counts as blocked after 1 s
    when a window opened meanwhile (its dialog), after 5 s otherwise, and only if a probe evaluation fails.
  - Clients on protocol 1.0 get results they can read: new target kinds (workers, service workers,
    offscreen pages) are listed as `other`, and IPC records of the new kinds are left out.
  - A page holding an older agent that cannot be replaced is no longer reinstalled on every call.
  - `session attach` keeps an app this session launched running, and a close while attaching no longer
    brings the session back. MCP paging cursors are per attach, so a new attach does not skip records.
  - Stackless renderer exceptions keep their column, so they are source-mapped again; an inline source
    map followed by another line (a `sourceURL`) is found again.
  - The console-flood and refused-recording `dropped` limitations cover only the page and range a query
    returns, instead of every drop since the app started.
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
- Updated dependencies [5a0e340]
- Updated dependencies [1c24fab]
- Updated dependencies [b85cb50]
  - @eab/core@1.1.0-rc.0
  - @eab/page-agent@1.1.0-rc.0
  - @eab/engine@1.1.0-rc.0
