# electron-agent-bridge

Let AI agents, scripts and tests see and drive any Electron app: its pages, IPC, logs, network, state
and main process. One bridge, three ways in: an **MCP server** for agents (Claude Code and other MCP
hosts), the **`eab` CLI**, and a typed **Node API**, plus **YAML flows** for tests.

- **See the app the way a user does.** Compact accessibility snapshots with stable refs (`button "Save"
  [e12]`), deltas of what changed, frames, views, webviews and offscreen windows, screenshots; console and network of workers and service workers too.
- **Act like a user.** Trusted clicks, typing, filling forms, keys, drag and drop, uploads, with
  auto-waiting and errors that say why (`OCCLUDED by dialog "Confirm"`), plus what the app did in
  response: dialogs, toasts, console errors, failed requests, IPC.
- **See inside.** IPC on both sides with request/response correlation, renderer and main logs, crashes,
  network metadata, Redux / Zustand / MobX state, application menus, native dialogs.
- **Safe by default.** Off unless `EAB_ENABLE=1`; refuses packaged builds unless opted in; local socket
  plus token; capability tiers (`eval` never by default); secrets redacted; page content marked
  untrusted for agents.

Electron 35+ on Windows, macOS and Linux.

## Quick start

> **Release candidate:** 1.1 is published under the `rc` tag until it is final, so install with `@rc`.

**Integrated** (the app imports the bridge, which does nothing unless enabled):

```sh
npm install --save-dev @eab/electron@rc @eab/mcp@rc
```

```js
// First line of the app's main entry.
import '@eab/electron/register';
```

```sh
EAB_ENABLE=1 npm start        # start the app with the bridge on
npx eab list                  # running apps the bridge can reach
npx eab snapshot              # what the focused window shows
```

**Launch** (no code change; the launcher injects the bridge into an unmodified, unfused app):

```sh
npx eab launch ./node_modules/.bin/electron -- .
```

**For agents:** add the MCP server to your MCP host, e.g.
`claude mcp add eab -- npx -y -p @eab/mcp@rc eab-mcp` (or `npx eab-mcp` where `@eab/mcp` is installed). The
agent then has 14 tools: `session`, `targets`, `snapshot`, `find`, `act`, `wait_for`, `screenshot`,
`logs`, `network`, `ipc`, `state`, `app`, and, where the app grants `eval`, `dialogs` and `eval`.

**For tests:**

```yaml
# checkout.flow.yaml
name: Place an order
steps:
  - act:
      - { type: fill, locator: { role: textbox, name: Customer }, value: Ada }
      - { type: click, locator: { role: button, name: Save order } }
  - expect: { text: Order saved }
  - expect: { noConsoleErrors: true }
```

```sh
npx eab run flows/ --junit report.xml --artifacts artifacts
```

**From code:**

```ts
import { connect } from '@eab/client';

const app = await connect();
const { data } = await app.call('snapshot.take', {});
await app.call('action.run', { actions: [{ type: 'click', locator: { role: 'button', name: 'Save' } }] });
```

## Documentation

| | |
|---|---|
| [Modes](docs/modes.md) | Integrated and Launch mode, gates, packaged builds |
| [Flows](docs/flows.md) | YAML tests and `eab run` |
| [IPC](docs/ipc.md) | what is recorded, correlation, values policy |
| [Logs and network](docs/logs-network.md) | sources, custom loggers, network metadata |
| [State](docs/state.md) | `registerState`, the devtools shim, reads, dispatch |
| [Main control](docs/main-control.md) | windows, menus, dialog stubs, `eval` |
| [Bundlers](docs/bundlers.md) | electron-vite, Forge, webpack |
| [Security](docs/security.md) | threat model and capabilities; [SECURITY.md](SECURITY.md) for reports |
| [Architecture](docs/architecture.md) | packages, data flow, design decisions (ADRs) |
| API reference | `pnpm docs:api` (TypeDoc) |

## Packages

| Package | |
|---|---|
| `@eab/electron` | in-app runtime (main process); `/register`, `/renderer` (`registerState`), `/inject` (Launch mode) |
| `@eab/mcp` | `eab-mcp` (MCP server over stdio) and the `eab` CLI |
| `@eab/client` | Node API: `connect`, `launch`, flows |
| `@eab/core`, `@eab/engine`, `@eab/page-agent` | protocol, engine and in-page agent (used by the others) |

## Development

```sh
pnpm install
pnpm check                         # format, lint, typecheck, boundaries, unit tests with coverage
EAB_E2E_ELECTRON=35,45 pnpm test:e2e
EAB_E2E_BACKGROUND=1 EAB_E2E_ELECTRON=35,45 pnpm test:e2e   # test windows stay off your screen
pnpm hooks                         # optional: git hooks (conventional commits, formatting)
```

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.
