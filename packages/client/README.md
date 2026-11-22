# @electron-agent-bridge/client

[![npm](https://img.shields.io/npm/v/@electron-agent-bridge/client?label=npm)](https://www.npmjs.com/package/@electron-agent-bridge/client)

The Node API of [electron-agent-bridge](https://github.com/Chavagov123/electron-agent-bridge#readme): connect to an Electron app running the bridge,
or launch one with it, and call the protocol with typed results.

```sh
npm install --save-dev @electron-agent-bridge/client
```

```ts
import { connect, launch } from '@electron-agent-bridge/client';

// An app started with EAB_ENABLE=1 (Integrated mode):
const app = await connect();
const { data } = await app.call('snapshot.take', {});
console.log(data.text);
await app.call('action.run', { actions: [{ type: 'click', locator: { role: 'button', name: 'Save' } }] });

// Or start an unmodified development build with the bridge injected (Launch mode):
const launched = await launch({ executable: './node_modules/.bin/electron', args: ['.'] });
await launched.client.call('targets.list', {});
await launched.close();
```

Also: `listInstances()` (running apps), YAML flows (`parseFlow`, `FlowSchema`), and `toPlaywright(flow)`.
[Docs](https://github.com/Chavagov123/electron-agent-bridge#documentation) · MIT licensed.
