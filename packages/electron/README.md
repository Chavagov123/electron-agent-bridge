# @electron-agent-bridge/electron

[![npm](https://img.shields.io/npm/v/@electron-agent-bridge/electron/rc?label=npm%40rc)](https://www.npmjs.com/package/@electron-agent-bridge/electron)
[![CI](https://github.com/Chavagov123/electron-agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Chavagov123/electron-agent-bridge/actions/workflows/ci.yml)

The in-app runtime of [electron-agent-bridge](https://github.com/Chavagov123/electron-agent-bridge#readme):
it lets AI agents, scripts and tests see and drive your Electron app (its pages, IPC, logs, network,
state and main process) through the `eab` CLI, the MCP server and the Node API.

**Off unless `EAB_ENABLE=1`**, refused in packaged builds unless you opt in, reachable only through a
private local socket with a token. Electron 35 or later.

## Install

```sh
npm install --save-dev @electron-agent-bridge/electron@rc @electron-agent-bridge/mcp@rc
```

(`@rc` while 1.1 is a release candidate.) `@electron-agent-bridge/mcp` brings the `eab` CLI and the
`eab-mcp` server that talk to the runtime.

## Use

Make it the **first** import of your main process:

```js
import '@electron-agent-bridge/electron/register'; // ESM
// require('@electron-agent-bridge/electron/register'); // CommonJS
```

Start the app with the bridge on, then look at it from another terminal:

```sh
EAB_ENABLE=1 npm start
npx eab list        # running apps the bridge can reach
npx eab snapshot    # what the focused window shows
```

Or give an agent the app: `claude mcp add eab -- npx eab-mcp` (any MCP host works).

No code change at all? `npx eab launch ./node_modules/.bin/electron -- .` injects the runtime into an
unmodified development build ([Launch mode](https://github.com/Chavagov123/electron-agent-bridge/blob/main/docs/modes.md)).

## Options

`register` uses the defaults. For options, call `enableAgentBridge` first thing instead:

```js
import { enableAgentBridge } from '@electron-agent-bridge/electron';

enableAgentBridge({
  ipc: { values: ['settings:*'] }, // record argument values (redacted) for these channels; others: shapes only
  logs: { mainConsole: true }, // also record the main process's console
  capabilities: ['observe', 'interact'], // what clients may do (no `eval` unless listed)
});
```

| Option | What it does |
|---|---|
| `allowPackaged` | Run in packaged builds too (still needs `EAB_ENABLE=1`). |
| `capabilities` | Ceiling for clients: `observe`, `interact`, `eval`. |
| `ipc.values` | Channel globs whose argument values are recorded (redacted). |
| `logs.mainConsole`, `logs.sources`, `logs.sourceMaps` | Main-process console, custom loggers (`addLogSource`, `loggerSource`), source-mapped stacks (default on). |
| `state.devtoolsShim` | Find Redux / Zustand / MobX stores through a devtools-extension shim. |
| `audit` | Audit log path, or `false`. |

## Entry points

| Import | For |
|---|---|
| `@electron-agent-bridge/electron/register` | One-line install with defaults (main process). |
| `@electron-agent-bridge/electron` | `enableAgentBridge`, `nameTarget`, `addLogSource`, `loggerSource`. |
| `@electron-agent-bridge/electron/renderer` | `registerState(name, store)` to expose a store to agents (renderer). |
| `@electron-agent-bridge/electron/inject` | Used by Launch mode; not imported by apps. |

## Docs

[Modes](https://github.com/Chavagov123/electron-agent-bridge/blob/main/docs/modes.md) ·
[IPC](https://github.com/Chavagov123/electron-agent-bridge/blob/main/docs/ipc.md) ·
[Logs and network](https://github.com/Chavagov123/electron-agent-bridge/blob/main/docs/logs-network.md) ·
[State](https://github.com/Chavagov123/electron-agent-bridge/blob/main/docs/state.md) ·
[Main control](https://github.com/Chavagov123/electron-agent-bridge/blob/main/docs/main-control.md) ·
[Bundlers](https://github.com/Chavagov123/electron-agent-bridge/blob/main/docs/bundlers.md) ·
[Security](https://github.com/Chavagov123/electron-agent-bridge/blob/main/docs/security.md)

MIT licensed.
