---
'@electron-agent-bridge/engine': patch
'@electron-agent-bridge/electron': patch
---

Fixes found driving a large bundled app:

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
