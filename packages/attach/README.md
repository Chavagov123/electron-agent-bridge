# @electron-agent-bridge/attach

[![npm](https://img.shields.io/npm/v/@electron-agent-bridge/attach/rc?label=npm%40rc)](https://www.npmjs.com/package/@electron-agent-bridge/attach)

Attach mode of [electron-agent-bridge](https://github.com/Chavagov123/electron-agent-bridge#readme): drive the pages of an Electron app that is
already running with `--remote-debugging-port`, without any bridge code inside the app. The engine runs
in your process; main-process features (IPC, main logs, windows, `eval`) need Integrated or Launch mode.

```sh
npm install --save-dev @electron-agent-bridge/attach@rc
```

```ts
import { attach } from '@electron-agent-bridge/attach';

const app = await attach({ port: 9222 });
const { data } = await app.call('snapshot.take', {});
app.close();
```

`attach` returns the same `BridgeClient` as `@electron-agent-bridge/client`. Anyone who can reach a remote
debugging port controls the pages, so expose it only on your own machine.
[Modes](https://github.com/Chavagov123/electron-agent-bridge/blob/main/docs/modes.md) · MIT licensed.
