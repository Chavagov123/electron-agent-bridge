// The source-map worker: reads and parses maps, and resolves locations, away from the app's main
// event loop (large bundles have maps of 10 MB and more, about 0.4 s each to read and parse). Bundled
// into a self-contained script by scripts/build-preload.mjs (src/generated/source-map-worker-source.ts).
import { parentPort } from 'node:worker_threads';

import type { MappedLocation, ScriptLocation } from '@eab/engine';

import { SourceMapResolver } from './source-maps.js';

export interface MapRequest {
  readonly id: number;
  readonly locations: readonly ScriptLocation[];
}

export interface MapReply {
  readonly id: number;
  readonly results: readonly (MappedLocation | null)[];
}

const resolver = new SourceMapResolver();

parentPort?.on('message', ({ id, locations }: MapRequest) => {
  const results = locations.map(({ url, line, column }) => {
    try {
      return resolver.map(url, line, column) ?? null;
    } catch {
      return null;
    }
  });
  parentPort?.postMessage({ id, results } satisfies MapReply);
});
