/**
 * Side-effect entry: `import '@electron-agent-bridge/electron/register'` (ESM) or `require('@electron-agent-bridge/electron/register')` (CJS)
 * as the **first** import of the app's main process. Does nothing unless `EAB_ENABLE=1`.
 * @packageDocumentation
 */
import { enableAgentBridge } from './index.js';

enableAgentBridge();
