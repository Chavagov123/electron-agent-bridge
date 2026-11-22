---
'@electron-agent-bridge/electron': patch
---

`@electron-agent-bridge/electron/register` loads the runtime of the main entry instead of bundling its
own copy: the package is about 40% smaller (676 KB packed, from 1.1 MB), and `register` and
`enableAgentBridge` now share one runtime instance.
