import { COMPONENT_READER_BUNDLE } from '../generated/component-reader-source.js';

/**
 * A function declaration for `Runtime.callFunctionOn` on an element in the main world:
 * `function (request) { … }` reads the component state behind `this` (see reader.ts).
 */
export const COMPONENT_READER_FUNCTION = `function (request) {${COMPONENT_READER_BUNDLE};return eabComponentReader.read(this, request);}`;
