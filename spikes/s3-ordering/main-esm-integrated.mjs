import './eab-register.cjs';               // first import: integrated install
import n from './handlers.mjs';
import { createRequire } from 'node:module';
createRequire(import.meta.url)('./report.cjs')('esm-integrated', n);
