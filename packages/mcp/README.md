# @electron-agent-bridge/mcp

[![npm](https://img.shields.io/npm/v/@electron-agent-bridge/mcp/rc?label=npm%40rc)](https://www.npmjs.com/package/@electron-agent-bridge/mcp)
[![CI](https://github.com/Chavagov123/electron-agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Chavagov123/electron-agent-bridge/actions/workflows/ci.yml)

The MCP server (`eab-mcp`) and CLI (`eab`) of
[electron-agent-bridge](https://github.com/Chavagov123/electron-agent-bridge#readme): give an AI agent, a
script or a CI job eyes and hands in a running Electron app.

The app runs the bridge runtime: either it imports
[`@electron-agent-bridge/electron`](https://www.npmjs.com/package/@electron-agent-bridge/electron)
(Integrated mode), or `eab launch` injects it (Launch mode, no code change).

## MCP server

```sh
claude mcp add eab -- npx -y -p @electron-agent-bridge/mcp@rc eab-mcp
```

Any MCP host works the same way (command `npx`, args `-y -p @electron-agent-bridge/mcp@rc eab-mcp`;
just `eab-mcp` where the package is installed). The agent gets 14 tools: `session`, `targets`,
`snapshot`, `find`, `act`, `wait_for`, `screenshot`, `logs`, `network`, `ipc`, `state`, `app`, and,
where the app grants `eval`, `dialogs` and `eval`.

`eab-mcp --allow-eval` lets the server grant main-process evaluation, launch apps with debug flags and
attach over a remote debugging port; without it those stay off.

## CLI

```sh
npm install --save-dev @electron-agent-bridge/mcp@rc

npx eab list                                   # apps with the bridge on
npx eab snapshot                               # accessibility outline of the focused window
npx eab act --json '{"actions":[{"type":"click","locator":{"role":"button","name":"Save"}}]}'
npx eab logs --minLevel error
npx eab launch ./node_modules/.bin/electron -- .   # start an unmodified app with the bridge
npx eab run flows/ --junit report.xml          # YAML test flows
npx eab record --out checkout.flow.yaml        # record what you do as a flow
npx eab export checkout.flow.yaml --playwright # the flow as a Playwright test
```

Every MCP tool is also a CLI command taking the same input; `eab <command> --help` lists it.

## Docs

[Flows](https://github.com/Chavagov123/electron-agent-bridge/blob/main/docs/flows.md) ·
[Modes](https://github.com/Chavagov123/electron-agent-bridge/blob/main/docs/modes.md) ·
[Security](https://github.com/Chavagov123/electron-agent-bridge/blob/main/docs/security.md) ·
[All docs](https://github.com/Chavagov123/electron-agent-bridge#documentation)

MIT licensed.
