import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MapReply, MapRequest } from './source-map-worker.js';
import { WorkerStackMapper, type MapWorker } from './worker-stack-mapper.js';

let directory: string | undefined;

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

/** A generated script with an external map, and where its `throw` is. */
function mappedScript(): { script: string; line: number; column: number } {
  directory = mkdtempSync(join(tmpdir(), 'eab-worker-maps-'));
  const script = join(directory, 'dist', 'thrower.js');
  buildSync({
    stdin: {
      contents: 'const pad: number = 1;\nexport function boom(): never {\n  throw new Error("x" + pad);\n}\n',
      sourcefile: join(directory, 'src', 'thrower.ts'),
      loader: 'ts',
    },
    outfile: script,
    format: 'cjs',
    sourcemap: true,
    write: true,
  });
  const lines = readFileSync(script, 'utf8').split('\n');
  const index = lines.findIndex((text) => text.includes('throw new Error'));
  return { script, line: index + 1, column: (lines[index] ?? '').indexOf('throw new Error') + 1 };
}

class FakeWorker extends EventEmitter implements MapWorker {
  readonly requests: MapRequest[] = [];
  terminated = false;
  postMessage(request: MapRequest): void {
    this.requests.push(request);
  }
  reply(reply: MapReply): void {
    this.emit('message', reply);
  }
  unref(): void {
    // Nothing keeps a fake alive.
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

describe('WorkerStackMapper', () => {
  it('resolves locations in the real worker, off the main thread', async () => {
    const { script, line, column } = mappedScript();
    const mapper = new WorkerStackMapper();
    try {
      const [mapped, missing] = await mapper.mapAll([
        { url: script, line, column },
        { url: 'app://bundle/main.js', line: 1, column: 1 },
      ]);
      expect(mapped).toMatchObject({ line: 3, column: 3 });
      expect(mapped?.url).toMatch(/thrower\.ts$/);
      expect(missing).toBeUndefined();
    } finally {
      mapper.close();
    }
  });

  it('answers unmapped when the worker dies, and maps in-process once workers keep failing', async () => {
    const workers: FakeWorker[] = [];
    const mapper = new WorkerStackMapper(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const location = { url: '/nowhere/a.js', line: 1, column: 1 };
    const first = mapper.mapAll([location]);
    workers[0]?.reply({ id: 99, results: [] });
    workers[0]?.emit('exit');
    expect(await first).toEqual([undefined]);
    const second = mapper.mapAll([location, location]);
    workers[1]?.reply({
      id: workers[1].requests[0]?.id ?? 0,
      results: [{ url: '/s.ts', line: 2, column: 1 }],
    });
    expect(await second).toEqual([{ url: '/s.ts', line: 2, column: 1 }, undefined]);
    workers[1]?.emit('error');
    const third = mapper.mapAll([location]);
    workers[2]?.emit('exit');
    await third;
    expect(await mapper.mapAll([location])).toEqual([undefined]);
    expect(workers).toHaveLength(3);
    expect(await mapper.mapAll([])).toEqual([]);
    mapper.close();
  });

  it('maps in-process when no worker can start, and ends its worker when closed', async () => {
    const throwing = new WorkerStackMapper(() => {
      throw new Error('no workers here');
    });
    expect(await throwing.mapAll([{ url: '/nowhere/a.js', line: 1, column: 1 }])).toEqual([undefined]);
    const worker = new FakeWorker();
    const mapper = new WorkerStackMapper(() => worker);
    const pending = mapper.mapAll([{ url: '/a.js', line: 1, column: 1 }]);
    mapper.close();
    expect(await pending).toEqual([undefined]);
    expect(worker.terminated).toBe(true);
  });

  it('ends a worker that never answers, and stops mapping after it keeps hanging', async () => {
    vi.useFakeTimers();
    try {
      const workers: FakeWorker[] = [];
      const mapper = new WorkerStackMapper(() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      }, 1_000);
      const location = { url: '/a.js', line: 1, column: 1 };
      for (let round = 0; round < 3; round++) {
        const hung = mapper.mapAll([location]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await hung).toEqual([undefined]);
        expect(workers[round]?.terminated).toBe(true);
      }
      // A map that hangs a worker would stall the main process too: no more attempts.
      expect(await mapper.mapAll([location])).toEqual([undefined]);
      expect(workers).toHaveLength(3);
      mapper.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
