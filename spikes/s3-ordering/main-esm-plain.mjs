import n from './handlers.mjs';           // unmodified app (Launch mode)
import { createRequire } from 'node:module';
createRequire(import.meta.url)('./report.cjs')(process.env.SPIKE_VARIANT || 'esm-plain', n);
