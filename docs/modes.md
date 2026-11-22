# Modes: how the bridge gets into an app

In Integrated and Launch mode the bridge runs inside the app's main process; Attach mode (1.1) reaches
only the app's renderers, from outside.

## Integrated (recommended for apps you develop)

Add one line as the **first** import of the main process and start the app with `EAB_ENABLE=1`:

```js
import '@eab/electron/register'; // ESM
// or: require('@eab/electron/register'); // CommonJS
```

- Off unless `EAB_ENABLE=1`; never in a packaged build unless the app calls
  `enableAgentBridge({ allowPackaged: true })` in code.
- Hooks are in place before the app registers IPC handlers or creates windows.
- Works for every app and every Electron build (fuses do not matter).

## Launch (zero changes to the app)

The launcher starts the app and injects the bridge:

```sh
eab launch /path/to/electron -- /path/to/app      # development build
eab launch "/Applications/My App.app/Contents/MacOS/My App" --allow-packaged
```

or from code: `launch({ executable, args, allowPackaged })` in `@eab/client`, or the MCP
`session` tool with `action: "launch"` (the app is closed with the session).

Strategies, tried in order (`--strategy` picks one):

1. **node-options**: `NODE_OPTIONS=--require <@eab/electron/inject>`. Needs the
   `EnableNodeOptionsEnvironmentVariable` fuse (on by default).
2. **inspector**: `--inspect-brk=0`, the bridge is injected before the app's first script and the
   inspector is closed again. Needs the `EnableNodeCliInspectArguments` fuse. Packaged apps with a
   CommonJS entry on Electron 35 may not be reachable this way.

Before starting anything, the launcher reads the fuses written in the binary (1.1; on macOS from the
Electron Framework in the bundle) and skips a strategy whose fuse is off. If both are blocked the
launch fails at once with `LAUNCH_BLOCKED`, naming the fuses; use Integrated mode then. When the fuses
cannot be read, each strategy is tried and a failure names the likely fuse.

`eab doctor <executable>` shows the same before you launch: every fuse, whether the app is packaged as
`app.asar`, and which strategies can work. A packaged build is refused with `NOT_ENABLED` unless `allowPackaged` / `--allow-packaged`
is given. The app's output goes to a log file whose path the launcher reports; nothing of the bridge
(`NODE_OPTIONS`, `EAB_*`, a debug port) is left for the app's own child processes.

## Attach (1.1: renderers of a running app, nothing in the app)

Start the app with a remote debugging port, then attach to it:

```sh
my-app --remote-debugging-port=9222
```

```js
import { attach } from '@eab/attach';
const client = await attach({ port: 9222 });
```

or the MCP `session` tool with `action: "attach", port: 9222` (only on a server started with
`eab-mcp --allow-eval`: whoever reaches the port fully controls the pages, so it counts as `eval`).

The engine runs in your process and reaches each page over its DevTools socket; the app runs
unmodified, with no bridge inside. Snapshots, actions, waits, screenshots, renderer logs and network,
store and component state, and recording work as in the other modes. What needs the main process
does not: `ipc`, main-process logs and requests, `app`, menus, dialogs, windows and `main.eval` answer
`UNSUPPORTED`, and the MCP server hides those tools. Without the runtime nothing is known of
windows and views beyond what CDP lists: every page counts as a window, the first one as focused.
The session's app name, version and pid come from the endpoint (Electron's user agent and the browser
target); pid is 0 when it cannot be told. Stores are found only once the state hook ran before them:
stores made while a page loaded before attaching show after that page reloads, and `state.read` says so.
`--remote-debugging-port` is not controlled by a fuse, so this also works for packaged apps whose
fuses block Launch mode.
