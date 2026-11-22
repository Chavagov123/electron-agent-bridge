# Logs and network

The bridge keeps what the app logged and which requests its pages made, so agents can see errors and
failed calls without a DevTools window (the `logs` and `network` tools, `logs.query` / `network.query`).

## Logs

| Source | What | How |
|---|---|---|
| `renderer` | `console.*` calls (incl. preloads and isolated worlds), uncaught exceptions with stack, preload errors | CDP `Runtime` per page; preload errors from `preload-error` |
| `main` | the main process's `console.*`, uncaught exceptions, process warnings (incl. unhandled rejections) | wrap-and-delegate of `console`; `uncaughtExceptionMonitor`; `warning` |
| `process` | renderer and child process exits, pages that failed to load, unresponsive / responsive pages | `render-process-gone`, `child-process-gone`, `did-fail-load`, `unresponsive` |
| `custom` | the app's own loggers | `loggerSource` / `addLogSource` (below) |

Entries live in a 1 MB ring (text and stack clipped at 4,000 characters each); readers learn how many
were evicted (`dropped`). Filters: `source`, `minLevel`, `target` (page id or name), `contains`
(case-insensitive, text or URL), and paging with `since` / `nextSeq` (`newOnly` in the MCP tool).

**Crashes behave exactly as without the bridge.** It only observes: `uncaughtExceptionMonitor` and
`warning` listeners, never `uncaughtException` or `unhandledRejection` ones, so Electron's error dialog,
the app's own handlers and Node's rejection warnings are unchanged (end-to-end test: bridge off vs on).

**Renderer capture starts with the first `logs.query`.** Until then the bridge adds no console traffic
to the main process. On start every page replays the messages it stored since its last load (Chromium
keeps about a thousand per page), so start-up errors are not lost. Objects are shown as their
description (`Object`, `Array(2)`, the error's stack), not expanded. Cross-origin iframes and workers
are not captured.

The main `console` is recorded unless the app turns it off:

```js
require('@electron-agent-bridge/electron').enableAgentBridge({ logs: { mainConsole: false } });
```

### The app's own loggers

```js
const { addLogSource, loggerSource } = require('@electron-agent-bridge/electron');
const log = require('electron-log'); // or winston, pino, any object with logger methods

addLogSource(loggerSource('app', log)); // wraps error/warn/info/log/debug/verbose/trace
```

`loggerSource` wraps the logger's methods and delegates to them unchanged; the method name gives the
level and the arguments are formatted like `console.log`. A logger that writes through the console is
recorded once. `addLogSource` works before the bridge starts and is a no-op while it is off, so it can
stay in the app's code. Anything else can be a source:

```js
addLogSource({
  name: 'jobs',
  install(sink) {
    const onFailed = (job) => sink.log({ level: 'error', text: `job ${job.id} failed` });
    queue.on('failed', onFailed);
    return () => queue.off('failed', onFailed);
  },
});
```

Entries appear with source `custom` and the source name in brackets: `[jobs] job 7 failed`.

### Console floods (1.1)

Each page's console is recorded at up to 1,000 messages per second (bursts of 2,000). Beyond that,
messages are counted instead of recorded: the next recorded message is preceded by a
`Console flood: N message(s) from this page were not recorded` entry, and `logs.query` reports the
count as a `dropped` limitation. Uncaught exceptions are never capped. This keeps a page that floods
its console from stalling the app's main process (docs/adr/0010-main-process-floods.md).

### Source-mapped stacks (1.1)

When logs are read, stack frames and the location of each entry are mapped to the original sources
through the scripts' source maps (a `sourceMappingURL` file next to the script, or an inline data URL),
and the entry is marked `mapped: true`. Only `file:` URLs and absolute paths are mapped; scripts served
from custom protocols or the network stay as they are. Maps are read on demand (up to 32 MB each; only
the end of a script is read to find its comment) and cached (50 scripts, 128 MB of maps), all in a
worker thread: the app's main process never stops to read or parse one (a 13 MB map takes about 0.4 s).
The worker starts with the first query and ends after five idle minutes. A query waits up to 2 s for
it; if maps are still loading, entries come back as recorded with a `partial` limitation, and the next
query is mapped. Turn it off with `enableAgentBridge({ logs: { sourceMaps: false } })`.

An entry's `url`, `line` and `column` point at the code that wrote it, not at whatever wraps the
console: frames of extensions (a DevTools hook), the runtime and dependencies (`node_modules`, also
after mapping — an error reporter's console patch) are passed over when the stack shows the app's own
code; otherwise the first real frame is kept. Frames in the message text are mapped too: React appends
a component stack to its warnings, and when the warning's own stack is all React, the first component
of the app's code in it gives the location. Stacks (errors, warnings, `console.trace`) keep ten
frames. Messages without a stack (`log`, `info`) are mapped by their column, and only see their first
frame — often the wrapper. So do messages a page logged before capture started: Chromium kept only
their top frame.

## Network

Request metadata of every page: method, URL, resource type, status, MIME type, duration, encoded size,
cache hits, failures (`net::ERR_…`, `blocked: <reason>`, `canceled`). **Bodies are never read.** Each
redirect hop is its own record. A request is listed once it finishes; requests still in flight are
counted in a limitation. Records live in a 2 MB ring; at most 1,000 unfinished requests are followed.

URLs are recorded with values of secret-looking query parameters (`token`, `apiKey`, `password`,
`session`…) and URL passwords replaced by `[redacted]`; data URLs are reduced to their type.

**Recording starts with the first `network.query`** (CDP `Network` is enabled lazily on every page,
again after a re-attach). Earlier requests are only there if an action or a `wait_for` had it on; repeat
the action to capture them. Filters: `target`, `url` (glob, e.g. `*api/orders*`), `failedOnly` (failures
and HTTP ≥ 400).

**Main-process requests (1.1)** are recorded with target `main`: Node's `http`/`https` and global `fetch`
through Node's diagnostics channels (observed, not patched), and Electron's `net.request`/`net.fetch`
through a delegating wrapper. They start recording with the first `network.query` too. Their bodies
are never read either, so a main-process request ends when its response headers arrive: `durMs` is the
time to headers, and there is no encoded size.

**Workers, service workers and cross-site iframes (1.1)** run in sessions of their own; the bridge
attaches to them automatically (without pausing them) and records their console output and requests
under ids like `wc3:w1` (worker), `wc3:s2` (service worker) and `wc3:f4` (iframe). Workers and service
workers are also listed by `targets` (kinds `worker` and `serviceWorker`); they have no page, so
snapshots and actions refuse them. Cross-site iframes are not part of their page's snapshot yet.
