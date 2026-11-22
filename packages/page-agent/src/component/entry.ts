/**
 * Bundle entry of the component reader: `eabComponentReader.read(el, request)`. Sent to the page's main
 * world with `Runtime.callFunctionOn` only when an agent asks (never installed in pages).
 */
export { read } from './reader.js';
