import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

import { SourceMapResolver, fileUrlOf } from './source-maps.js';

let directory: string | undefined;

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

/** Bundle a two-line TypeScript source the way an app would, with an external or inline map. */
function bundle(sourcemap: 'external' | 'inline'): { script: string; source: string } {
  directory = mkdtempSync(join(tmpdir(), 'eab-maps-'));
  const source = join(directory, 'src', 'thrower.ts');
  const script = join(directory, 'dist', 'thrower.js');
  writeFileSync(join(directory, 'entry.ts'), "export { boom } from './src/thrower';\n");
  rmSync(join(directory, 'src'), { recursive: true, force: true });
  buildSync({
    stdin: {
      contents: 'const pad: number = 1;\nexport function boom(): never {\n  throw new Error("x" + pad);\n}\n',
      sourcefile: source,
      loader: 'ts',
    },
    outfile: script,
    bundle: false,
    format: 'cjs',
    sourcemap: sourcemap === 'external' ? true : 'inline',
    write: true,
  });
  return { script, source };
}

describe('SourceMapResolver', () => {
  it.each(['external', 'inline'] as const)('maps a %s source map back to the original line', (kind) => {
    const { script, source } = bundle(kind);
    const resolver = new SourceMapResolver();
    // The throw is on the generated file's line where `throw` appears; find it to stay robust.
    const generated = readFileSync(script, 'utf8');
    const line = generated.split('\n').findIndex((text) => text.includes('throw new Error')) + 1;
    const column = (generated.split('\n')[line - 1] ?? '').indexOf('throw new Error') + 1;
    for (const url of [fileUrlOf(script), script]) {
      expect(resolver.map(url, line, column)).toEqual({ url: source, line: 3, column: 3 });
    }
  });

  it('leaves scripts without maps, missing files, custom protocols and remote URLs alone', () => {
    directory = mkdtempSync(join(tmpdir(), 'eab-maps-'));
    const plain = join(directory, 'plain.js');
    writeFileSync(plain, 'throw new Error("x");\n');
    const resolver = new SourceMapResolver();
    expect(resolver.map(plain, 1, 1)).toBeUndefined();
    expect(resolver.map(join(directory, 'missing.js'), 1, 1)).toBeUndefined();
    expect(resolver.map('app://bundle/main.js', 1, 1)).toBeUndefined();
    expect(resolver.map('https://cdn.test/a.js', 1, 1)).toBeUndefined();
    writeFileSync(join(directory, 'broken.js'), 'x\n//# sourceMappingURL=broken.js.map\n');
    writeFileSync(join(directory, 'broken.js.map'), '{not json');
    expect(resolver.map(join(directory, 'broken.js'), 1, 1)).toBeUndefined();
  });

  it('finds the map of a large bundle from its end, and an inline map longer than that end', () => {
    directory = mkdtempSync(join(tmpdir(), 'eab-maps-'));
    const map = (source: string): string =>
      JSON.stringify({ version: 3, sources: [source], names: [], mappings: 'AAAA' });
    const large = join(directory, 'large.js');
    writeFileSync(large, `x\n${'// padding\n'.repeat(20_000)}//# sourceMappingURL=large.js.map\n`);
    writeFileSync(join(directory, 'large.js.map'), map('src/large.ts'));
    const inline = join(directory, 'inline.js');
    const padded = { ...(JSON.parse(map('src/inline.ts')) as object), sourcesContent: ['y'.repeat(50_000)] };
    writeFileSync(
      inline,
      `x\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(padded)).toString('base64')}\n`,
    );
    const resolver = new SourceMapResolver();
    expect(resolver.map(large, 1, 1)).toEqual({
      url: join(directory, 'src', 'large.ts'),
      line: 1,
      column: 1,
    });
    expect(resolver.map(inline, 1, 1)).toEqual({
      url: join(directory, 'src', 'inline.ts'),
      line: 1,
      column: 1,
    });
    // A line after the map comment (a sourceURL, a banner): still found, inline or not.
    const followed = join(directory, 'followed.js');
    writeFileSync(
      followed,
      `x\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(padded)).toString('base64')}\n//# sourceURL=followed.js\n`,
    );
    expect(resolver.map(followed, 1, 1)?.url).toBe(join(directory, 'src', 'inline.ts'));
    const external = join(directory, 'external.js');
    writeFileSync(external, `x\n//# sourceMappingURL=large.js.map\n/* built */\n`);
    expect(resolver.map(external, 1, 1)?.url).toBe(join(directory, 'src', 'large.ts'));
    // A large script without a map is not read whole.
    const plain = join(directory, 'plain.js');
    writeFileSync(plain, 'call();\n'.repeat(5_000));
    expect(resolver.map(plain, 1, 1)).toBeUndefined();
  });

  it('reads a script again once it was rebuilt', () => {
    directory = mkdtempSync(join(tmpdir(), 'eab-maps-'));
    const script = join(directory, 'a.js');
    writeFileSync(script, 'x\n');
    const resolver = new SourceMapResolver();
    expect(resolver.map(script, 1, 1)).toBeUndefined();
    const map = { version: 3, sources: ['src/a.ts'], names: [], mappings: 'AAAA' };
    writeFileSync(
      script,
      `x\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`,
    );
    expect(resolver.map(script, 1, 1)).toEqual({ url: join(directory, 'src', 'a.ts'), line: 1, column: 1 });
  });
});
