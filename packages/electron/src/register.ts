/**
 * Side-effect entry: `import '@eab/electron/register'` (ESM) or `require('@eab/electron/register')` (CJS)
 * as the **first** import of the app's main process. Does nothing unless `EAB_ENABLE=1`.
 * @packageDocumentation
 */
import { enableAgentBridge } from './index.js';

enableAgentBridge();
