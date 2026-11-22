# Main-process control

The `app` tool (`app.info`, `window.control`, `menu.click`), and, only where the app grants the `eval`
capability, the `dialogs` and `eval` tools (`dialog.stub`, `main.eval`).

## App, windows, menus (capabilities `observe` / `interact`)

- **`app.info`**: name, version, Electron/Chrome/Node versions, platform, packaged or not, pid, and every
  window (id, page target, title, visible, focused, minimized, bounds).
- **`window.control`**: `focus`, `show`, `hide`, `minimize`, `maximize`, `restore`, `close` (the app's
  `close` handlers still run and may prevent it), `setBounds` (any of x, y, width, height).
- **`menu.click`**: an application-menu item by `id` or by label path (`["File", "Open…"]`; mnemonics
  `&`, trailing `…`/`...` and case are ignored). The item's own click handler runs with the focused
  window, as for a user. Disabled or hidden items (or menus on the way) fail with `DISABLED` / `HIDDEN`;
  a missing one with `NOT_FOUND` listing the items that exist there.

## Dialog stubs and evaluation (capability `eval`)

Both change how the app behaves or run arbitrary code, so they need `eval`, which no client gets unless
the app (or its launcher) grants it:

```js
// Integrated mode: the app raises its own ceiling.
require('@eab/electron').enableAgentBridge({ capabilities: ['observe', 'interact', 'eval'] });
```

```sh
# Launch mode: only an explicit launcher option grants it.
eab launch ./node_modules/.bin/electron --allow-eval -- ./my-app
```

From the API: `launch({ executable, allowEval: true })`. Through MCP, `session action=launch allowEval`
works only if the operator started the server with `eab-mcp --allow-eval`; without it, app arguments that
open a debugger (`--inspect*`, `--remote-debugging-*`, `--js-flags`) are refused too. MCP `launch` still
runs the program the agent names: grant that tool only as far as you would let the agent run programs.
The `eval` and `dialogs` tools are listed only while the session has `eval`.

**`dialog.stub`** queues answers for `showOpenDialog`, `showSaveDialog` and `showMessageBox` (the `Sync`
variants too: they get `filePaths`, `filePath` or `response`). While answers are queued, the next dialog
of that kind returns the next answer without showing; then the real dialogs show again. Missing fields
get defaults (`canceled: false`, `filePaths: []`, `response: 0`). `session.reset`, the controlling
client disconnecting, and the bridge stopping all drop the queues and restore Electron's functions.
Code that kept its own reference to a dialog function (`const { showOpenDialog } = dialog`) is not
stubbed.

**Dialogs that are windows.** Many apps draw their own confirm and message boxes in a small modal
`BrowserWindow` (often loaded from a `data:` URL) rather than through `dialog`. `dialog.stub` cannot
answer those; they are ordinary targets: `targets` lists them (named by their title), and `snapshot` and
`act` read and click them like any page. When the page that asked waits for the answer with
`ipcRenderer.sendSync`, it runs nothing until the dialog closes. Page calls to it (snapshot, find, act,
wait, screenshot, state) then fail fast with `TIMEOUT` instead of hanging: the error names the
`sendSync` channel and how long it has waited, says whether the call ran, and lists the other targets
so the agent can answer the dialog first (1.1). A page counts as blocked when its `sendSync` has been
unanswered for over 1 s while a new window opened (its dialog), or for over 5 s otherwise (a slow sync
handler finishes sooner and its calls just wait), and it then fails to run a trivial evaluation within
300 ms. A page that does answer was not blocked: the bridge forgets its waits.

**`main.eval`** runs an expression (`app.getName()`, `await win.webContents.getURL()`) or a function
body (`const w = …; return w.id`) in the main process, with `require` (resolving from the app),
`electron` and `app` in scope. Code without `await` runs under a `vm` timeout (default 5 s, `timeoutMs`
up to 60 s), so an endless loop is interrupted; a returned promise is awaited within the same limit.
Code after an `await` runs on the main event loop and cannot be interrupted: an endless loop there
freezes the app. The result is JSON-safe, bounded and redacted; a throw comes back as `type: "error"`
with its name, message and stack. Expressions are never written to the audit log.
