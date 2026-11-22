# @electron-agent-bridge/page-agent


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
- Flow recorder and Playwright export. `record.start` / `record.events` / `record.stop` capture what
  users do in the app's pages (clicks, field values, checkbox/select changes, command keys) and what
  agents run with `act`, each with a locator that outlives refs; password values are never recorded.
  `eab record --out flow.yaml` and the MCP `session` actions `recordStart`/`recordStop` turn that into a
  flow. `eab export <flow> --playwright` (or `toPlaywright(flow)`) writes the flow as a Playwright test
  for Electron. `stringifyFlow` and `flowFromRecording` are new in `@electron-agent-bridge/client`.

### Patch Changes

- More fixes found driving a large bundled React app:
  
  - An Electron `<webview>` shows in its host page's snapshot as `webview "…" [eN] separate target (see
    targets)`, no longer as a cross-origin iframe left out of the snapshot.
  - A combobox that is a `<button>` (Radix and shadcn selects) shows its choice as its value.
  - Recording: a click that opens an overlay (a select's menu, which lands the click on the page and
    hides the page behind it) is recorded on the control that was pressed, with the locator it had
    before the overlay opened; a click on the page itself is not recorded; a `generic` clickable is
    recorded by its text, which other tools (Playwright) can find.
  - An agent left in a page by an older bridge is replaced by the current one (Attach mode to an app
    that kept running); agents that cannot be replaced keep working as before.
  - A page whose title is still its file name (`Index.html`) is named after the file, not that title.
  - Hints: NOT_FOUND mentions that a dialog hides the page behind it; a delta that falls back to a full
    snapshot because `maxLines` changed says so.
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
